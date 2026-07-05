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
    includeUser: true,
    includeCharacter: true,
    includeName: true,
};

let activeRunId = 0;
let isSpeakingRange = false;

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

function getRangeMessages(from, to) {
    const messages = getNarratableMessages();
    if (!messages.length) {
        return [];
    }

    const start = Math.max(1, Math.min(from, to));
    const end = Math.min(messages.length, Math.max(from, to));
    const settings = getSettings();

    return messages.slice(start - 1, end).filter(({ message }) => {
        if (message.is_user && !settings.includeUser) {
            return false;
        }
        if (!message.is_user && !settings.includeCharacter) {
            return false;
        }
        return true;
    });
}

function buildMessageText(message) {
    const settings = getSettings();
    const text = stripHtml(message?.extra?.display_text || message?.mes).trim();
    if (!text) {
        return '';
    }

    if (!settings.includeName) {
        return text;
    }

    const name = String(message?.name || (message?.is_user ? 'User' : 'Assistant')).trim();
    return `${name}: ${text}`;
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
    return rangeMessages.flatMap(({ message }) => splitLongText(buildMessageText(message)));
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

async function waitForCurrentTtsAudio(runId, state, timeoutMs = 600000) {
    const start = Date.now();
    let sawActiveAudio = false;
    let sawGeneratedAudio = false;
    let idleSince = 0;

    while (Date.now() - start < timeoutMs) {
        if (runId !== activeRunId) {
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

        // Very short clips can finish between polling ticks. Permit that only
        // after TTS has produced audio and the dedicated TTS element has ended.
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
    stopNativePlaybackOnly();
    toastr.info(`开始逐段朗读，共 ${queue.length} 段。`);

    try {
        for (let i = 0; i < queue.length; i++) {
            if (runId !== activeRunId) {
                break;
            }
            $('#st_tts_range_progress').text(`${i + 1}/${queue.length}`);
            const ok = await speakTextAndWait(queue[i], runId);
            if (!ok) {
                break;
            }
            await delay(150);
        }
    } finally {
        if (runId === activeRunId) {
            isSpeakingRange = false;
            $('#st_tts_range_progress').text('完成');
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

function stopSpeaking() {
    activeRunId++;
    isSpeakingRange = false;
    stopNativePlaybackOnly();
    $('#st_tts_range_progress').text('已停止');
    toastr.info('已停止朗读。');
}

function updateStatus() {
    const settings = getSettings();
    const count = getNarratableMessages().length;
    $('#st_tts_range_total').text(String(count));
    $('#st_tts_range_from').val(settings.from);
    $('#st_tts_range_to').val(settings.to || count || 1);
    $('#st_tts_range_include_user').prop('checked', Boolean(settings.includeUser));
    $('#st_tts_range_include_character').prop('checked', Boolean(settings.includeCharacter));
    $('#st_tts_range_include_name').prop('checked', Boolean(settings.includeName));
    $('#st_tts_range_progress').text(isSpeakingRange ? $('#st_tts_range_progress').text() : '-');
}

function readControls() {
    const settings = getSettings();
    const total = getNarratableMessages().length || 1;
    settings.from = Math.min(normalizeIndex($('#st_tts_range_from').val(), settings.from), total);
    settings.to = Math.min(normalizeIndex($('#st_tts_range_to').val(), settings.to || settings.from), total);
    settings.includeUser = $('#st_tts_range_include_user').prop('checked');
    settings.includeCharacter = $('#st_tts_range_include_character').prop('checked');
    settings.includeName = $('#st_tts_range_include_name').prop('checked');
    saveSettings();
    updateStatus();
    return settings;
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
            <div class="sttrc-row">
                <label for="st_tts_range_from">起始</label>
                <input id="st_tts_range_from" class="text_pole" type="number" min="1" step="1">
                <label for="st_tts_range_to">结束</label>
                <input id="st_tts_range_to" class="text_pole" type="number" min="1" step="1">
            </div>
            <div class="sttrc-total">可朗读消息数：<span id="st_tts_range_total">0</span></div>
            <div class="sttrc-total">当前进度：<span id="st_tts_range_progress">-</span></div>
            <label class="checkbox_label sttrc-check">
                <input id="st_tts_range_include_user" type="checkbox">
                <span>包含用户消息</span>
            </label>
            <label class="checkbox_label sttrc-check">
                <input id="st_tts_range_include_character" type="checkbox">
                <span>包含角色消息</span>
            </label>
            <label class="checkbox_label sttrc-check">
                <input id="st_tts_range_include_name" type="checkbox">
                <span>朗读说话人名字</span>
            </label>
            <div class="sttrc-actions">
                <button id="st_tts_range_play" class="menu_button fa-solid fa-play" title="朗读范围"></button>
                <button id="st_tts_range_first" class="menu_button sttrc-text-button" title="起始设为最开始">最开始</button>
                <button id="st_tts_range_latest" class="menu_button sttrc-text-button" title="结束设为最新">最新</button>
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
    $('#st_tts_range_play').on('click', async () => {
        if (isSpeakingRange) {
            stopSpeaking();
            return;
        }
        const settings = readControls();
        await speakRange(settings.from, settings.to);
    });
    $('#st_tts_range_from, #st_tts_range_to, #st_tts_range_include_user, #st_tts_range_include_character, #st_tts_range_include_name')
        .on('change', readControls);
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
