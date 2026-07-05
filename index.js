import { cancelTtsPlay } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const EXTENSION_KEY = 'ttsRangeControl';
const MAX_CHUNK_LENGTH = 800;
const DEFAULT_SETTINGS = {
    from: 1,
    to: 1,
};

let activeRunId = 0;
let isSpeakingRange = false;
let isPaused = false;
let currentMessageIndex = null;

function getSettings() {
    extension_settings[EXTENSION_KEY] ??= {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        extension_settings[EXTENSION_KEY][key] ??= value;
    }
    return extension_settings[EXTENSION_KEY];
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

function normalizeIndex(value, fallback) {
    const number = Number.parseInt(String(value), 10);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getNarratableMessages() {
    const context = getContext();
    return context.chat
        .map((message, chatIndex) => ({ message, chatIndex }))
        .filter(({ message }) => {
            return message && !message.is_system && message.mes !== '...' && String(message.mes ?? '').trim();
        });
}

function stripHtml(text) {
    const node = document.createElement('div');
    node.innerHTML = String(text ?? '');
    return node.textContent || node.innerText || '';
}

function getMessagePreview(index) {
    const messages = getNarratableMessages();
    const item = messages[index - 1];
    if (!item) {
        return '没有对应消息';
    }

    const { message } = item;
    const name = String(message?.name || (message?.is_user ? '用户' : '角色')).trim();
    const text = stripHtml(message?.extra?.display_text || message?.mes).replace(/\s+/g, ' ').trim();
    return `${index}. ${name}: ${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`;
}

function getRangeMessages(from, to) {
    const messages = getNarratableMessages();
    if (!messages.length) {
        return [];
    }

    const start = Math.max(1, Math.min(from, to));
    const end = Math.min(messages.length, Math.max(from, to));
    return messages.slice(start - 1, end);
}

function buildMessageText(message) {
    return stripHtml(message?.extra?.display_text || message?.mes).trim();
}

function splitLongText(text, maxLength = MAX_CHUNK_LENGTH) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (normalized.length <= maxLength) {
        return normalized ? [normalized] : [];
    }

    const parts = normalized
        .split(/(?<=[。！？.!?])\s+|\n{2,}/u)
        .map(x => x.trim())
        .filter(Boolean);

    const chunks = [];
    let current = '';
    for (const part of parts.length ? parts : [normalized]) {
        if (part.length > maxLength) {
            if (current) {
                chunks.push(current);
                current = '';
            }
            for (let i = 0; i < part.length; i += maxLength) {
                chunks.push(part.slice(i, i + maxLength));
            }
            continue;
        }

        const next = current ? `${current}\n${part}` : part;
        if (next.length > maxLength) {
            chunks.push(current);
            current = part;
        } else {
            current = next;
        }
    }

    if (current) {
        chunks.push(current);
    }
    return chunks;
}

function buildSpeechQueue(rangeMessages) {
    return rangeMessages.flatMap(({ message }, offset) => {
        return splitLongText(buildMessageText(message)).map(text => ({
            text,
            messageIndex: offset,
        }));
    });
}

function getSpeakCommand() {
    return SlashCommandParser.commands.speak || SlashCommandParser.commands.tts || SlashCommandParser.commands.narrate;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getTtsAudioElement() {
    return document.getElementById('tts_audio');
}

function isAudioFinished(audio) {
    if (audio.ended) {
        return true;
    }

    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        return false;
    }

    return audio.paused && audio.currentTime >= Math.max(0, audio.duration - 0.15);
}

async function waitWhilePaused(runId) {
    while (isPaused && runId === activeRunId) {
        await delay(250);
    }
    return runId === activeRunId;
}

async function waitForCurrentTtsAudio(runId, state, timeoutMs = 600000) {
    const start = Date.now();
    let sawActiveAudio = false;
    let sawGeneratedAudio = false;
    let idleSince = 0;

    while (Date.now() - start < timeoutMs) {
        if (runId !== activeRunId) {
            return false;
        }
        if (!(await waitWhilePaused(runId))) {
            return false;
        }

        if (state.audioReady || state.jobComplete) {
            sawGeneratedAudio = true;
        }

        const audio = getTtsAudioElement();
        const hasAudioSource = audio?.src && !audio.src.includes('/sounds/silence.mp3');
        const isActive = hasAudioSource && !audio.paused && !audio.ended;
        if (isActive) {
            sawActiveAudio = true;
            idleSince = 0;
        }

        const isFinished = hasAudioSource && isAudioFinished(audio);
        if (state.jobComplete && sawActiveAudio && isFinished) {
            idleSince ||= Date.now();
            if (Date.now() - idleSince > 750) {
                return true;
            }
        } else if (idleSince && isActive) {
            idleSince = 0;
        }

        if (!sawActiveAudio && sawGeneratedAudio && hasAudioSource && audio.ended) {
            idleSince ||= Date.now();
            if (Date.now() - idleSince > 750) {
                return true;
            }
        }

        await delay(250);
    }

    return true;
}

async function speakTextAndWait(text, runId) {
    const speakCommand = getSpeakCommand();
    if (!speakCommand) {
        toastr.warning('TTS 命令不可用。请先启用 SillyTavern 的 TTS 扩展。');
        return false;
    }

    const context = getContext();
    const state = {
        audioReady: false,
        audioReadyAt: 0,
        jobComplete: false,
    };
    const onAudioReady = () => {
        state.audioReady = true;
        state.audioReadyAt = Date.now();
    };
    const onJobComplete = () => {
        state.jobComplete = true;
    };

    context.eventSource.on(context.eventTypes.TTS_AUDIO_READY, onAudioReady);
    context.eventSource.on(context.eventTypes.TTS_JOB_COMPLETE, onJobComplete);
    try {
        await speakCommand.callback({}, text);
        await waitForCurrentTtsAudio(runId, state);
        return runId === activeRunId;
    } finally {
        context.eventSource.removeListener(context.eventTypes.TTS_AUDIO_READY, onAudioReady);
        context.eventSource.removeListener(context.eventTypes.TTS_JOB_COMPLETE, onJobComplete);
    }
}

async function speakRange(from, to) {
    const rangeMessages = getRangeMessages(from, to);
    if (!rangeMessages.length) {
        toastr.info('这个范围内没有可朗读的消息。');
        return '';
    }

    const queue = buildSpeechQueue(rangeMessages);
    if (!queue.length) {
        toastr.info('选中的消息没有可朗读文本。');
        return '';
    }

    const runId = ++activeRunId;
    isSpeakingRange = true;
    isPaused = false;
    currentMessageIndex = Math.min(from, to);
    stopNativePlaybackOnly();
    updatePlaybackButton();
    toastr.info(`开始逐段朗读，共 ${queue.length} 段。`);

    try {
        for (let i = 0; i < queue.length; i++) {
            if (runId !== activeRunId) {
                break;
            }
            currentMessageIndex = Math.min(from, to) + queue[i].messageIndex;
            $('#st_tts_range_progress').text(`${i + 1}/${queue.length}`);
            const ok = await speakTextAndWait(queue[i].text, runId);
            if (!ok) {
                break;
            }
            await delay(150);
        }
    } finally {
        if (runId === activeRunId) {
            isSpeakingRange = false;
            isPaused = false;
            currentMessageIndex = null;
            $('#st_tts_range_progress').text('完成');
            updatePlaybackButton();
            toastr.success(`已朗读第 ${Math.min(from, to)} 到第 ${Math.max(from, to)} 条消息。`);
        }
    }

    return queue.join('\n\n');
}

function stopNativePlaybackOnly() {
    cancelTtsPlay();
    window.speechSynthesis?.cancel?.();
    document.querySelectorAll('audio').forEach(audio => {
        audio.pause();
        audio.currentTime = 0;
    });
}

function stopSpeaking(notify = true) {
    activeRunId++;
    isSpeakingRange = false;
    isPaused = false;
    currentMessageIndex = null;
    stopNativePlaybackOnly();
    $('#st_tts_range_progress').text('已停止');
    updatePlaybackButton();
    if (notify) {
        toastr.info('已停止朗读。');
    }
}

function updatePlaybackButton() {
    const button = $('#st_tts_range_play_pause');
    if (!button.length) {
        return;
    }

    button
        .toggleClass('fa-play', !isSpeakingRange || isPaused)
        .toggleClass('fa-pause', isSpeakingRange && !isPaused)
        .attr('title', isSpeakingRange && !isPaused ? '暂停朗读' : '开始朗读');
}

function pauseSpeaking() {
    const audio = getTtsAudioElement();
    isPaused = true;
    audio?.pause?.();
    updatePlaybackButton();
    $('#st_tts_range_progress').text('已暂停');
}

function resumeSpeaking() {
    const audio = getTtsAudioElement();
    isPaused = false;
    audio?.play?.();
    updatePlaybackButton();
}

function updatePreview() {
    const from = normalizeIndex($('#st_tts_range_from').val(), getSettings().from);
    const to = normalizeIndex($('#st_tts_range_to').val(), getSettings().to);
    $('#st_tts_range_from_preview').text(getMessagePreview(from));
    $('#st_tts_range_to_preview').text(getMessagePreview(to));
}

function updateStatus() {
    const settings = getSettings();
    const count = getNarratableMessages().length;
    settings.from = Math.min(normalizeIndex(settings.from, 1), count || 1);
    settings.to = Math.min(normalizeIndex(settings.to, count || 1), count || 1);
    $('#st_tts_range_total').text(String(count));
    $('#st_tts_range_from, #st_tts_range_to').attr('max', count || 1);
    $('#st_tts_range_from').val(settings.from);
    $('#st_tts_range_to').val(settings.to || count || 1);
    $('#st_tts_range_from_value').text(String(settings.from));
    $('#st_tts_range_to_value').text(String(settings.to || count || 1));
    $('#st_tts_range_progress').text(isSpeakingRange ? $('#st_tts_range_progress').text() : '-');
    updatePreview();
    updatePlaybackButton();
}

function readControls() {
    const settings = getSettings();
    const total = getNarratableMessages().length || 1;
    settings.from = Math.min(normalizeIndex($('#st_tts_range_from').val(), settings.from), total);
    settings.to = Math.min(normalizeIndex($('#st_tts_range_to').val(), settings.to || settings.from), total);
    saveSettings();
    updateStatus();
    return settings;
}

async function jumpStartToMessage(index) {
    const total = getNarratableMessages().length || 1;
    const target = Math.min(total, Math.max(1, index));
    const settings = readControls();
    const shouldRestart = isSpeakingRange;
    if (shouldRestart) {
        stopSpeaking(false);
    }

    settings.from = target;
    saveSettings();
    updateStatus();

    if (shouldRestart) {
        await speakRange(settings.from, settings.to);
    }
}

async function shiftRange(delta) {
    const settings = readControls();
    const anchor = currentMessageIndex ?? settings.from;
    await jumpStartToMessage(anchor + delta);
}

function openPanel() {
    updateStatus();
    $('#st_tts_range_panel').toggleClass('sttrc-hidden');
}

function createPanel() {
    const panel = $(`
        <div id="st_tts_range_panel" class="sttrc-panel sttrc-hidden">
            <div class="sttrc-header">
                <span>朗读范围</span>
                <button id="st_tts_range_close" class="menu_button fa-solid fa-xmark" title="关闭"></button>
            </div>
            <div class="sttrc-range-line">
                <label for="st_tts_range_from">起始 <span id="st_tts_range_from_value">1</span></label>
                <input id="st_tts_range_from" type="range" min="1" max="1" step="1">
                <button id="st_tts_range_first" class="menu_button sttrc-text-button" title="起始设为最开始">最开始</button>
            </div>
            <div id="st_tts_range_from_preview" class="sttrc-preview"></div>
            <div class="sttrc-range-line">
                <label for="st_tts_range_to">结束 <span id="st_tts_range_to_value">1</span></label>
                <input id="st_tts_range_to" type="range" min="1" max="1" step="1">
                <button id="st_tts_range_latest" class="menu_button sttrc-text-button" title="结束设为最新">最新</button>
            </div>
            <div id="st_tts_range_to_preview" class="sttrc-preview"></div>
            <div class="sttrc-total">可朗读消息数：<span id="st_tts_range_total">0</span></div>
            <div class="sttrc-total">当前进度：<span id="st_tts_range_progress">-</span></div>
            <div class="sttrc-actions">
                <button id="st_tts_range_prev" class="menu_button fa-solid fa-chevron-left" title="上一个对话"></button>
                <button id="st_tts_range_play_pause" class="menu_button fa-solid fa-play" title="开始朗读"></button>
                <button id="st_tts_range_next" class="menu_button fa-solid fa-chevron-right" title="下一个对话"></button>
                <button id="st_tts_range_stop" class="menu_button fa-solid fa-stop" title="停止朗读"></button>
                <button id="st_tts_range_refresh" class="menu_button fa-solid fa-rotate" title="刷新数量"></button>
            </div>
        </div>
    `);

    $('body').append(panel);
    $('#extensionsMenu').append(`
        <div id="st_tts_range_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-headphones-simple extensionsMenuExtensionButton" title="朗读范围控制"></div>
            <span>朗读范围</span>
        </div>
    `);

    $('#st_tts_range_button').on('click', openPanel);
    $('#st_tts_range_close').on('click', () => $('#st_tts_range_panel').addClass('sttrc-hidden'));
    $('#st_tts_range_refresh').on('click', updateStatus);
    $('#st_tts_range_stop').on('click', stopSpeaking);
    $('#st_tts_range_prev').on('click', () => shiftRange(-1));
    $('#st_tts_range_next').on('click', () => shiftRange(1));
    $('#st_tts_range_first').on('click', () => {
        const settings = getSettings();
        settings.from = 1;
        saveSettings();
        updateStatus();
    });
    $('#st_tts_range_latest').on('click', () => {
        const total = getNarratableMessages().length || 1;
        const settings = getSettings();
        settings.to = total;
        saveSettings();
        updateStatus();
    });
    $('#st_tts_range_play_pause').on('click', async () => {
        if (isSpeakingRange && !isPaused) {
            pauseSpeaking();
            return;
        }
        if (isSpeakingRange && isPaused) {
            resumeSpeaking();
            return;
        }
        const settings = readControls();
        await speakRange(settings.from, settings.to);
    });
    $('#st_tts_range_from, #st_tts_range_to').on('input change', () => {
        readControls();
        updatePreview();
    });
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tts-range',
        aliases: ['speak-range', 'narrate-range'],
        callback: async (args) => {
            const settings = getSettings();
            const from = normalizeIndex(args?.from, settings.from);
            const to = normalizeIndex(args?.to, settings.to || from);
            settings.from = from;
            settings.to = to;
            saveSettings();
            await speakRange(from, to);
            updateStatus();
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'from',
                description: '要朗读的起始消息编号，从 1 开始',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'to',
                description: '要朗读的结束消息编号，从 1 开始',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: true,
            }),
        ],
        helpString: `
            <div>逐段朗读当前聊天中的指定消息范围。</div>
            <div>消息编号从 1 开始，隐藏的 system 消息不会计入。</div>
            <div><strong>Example:</strong> <code>/tts-range from=3 to=8</code></div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tts-range-stop',
        callback: () => {
            stopSpeaking();
            return '';
        },
        helpString: '<div>停止当前朗读。</div>',
    }));
}

jQuery(() => {
    getSettings();
    createPanel();
    registerSlashCommands();
    updateStatus();
});
