import { cancelTtsPlay } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const EXTENSION_KEY = 'ttsRangeControl';
const DEFAULT_SETTINGS = {
    from: 1,
    to: 1,
    includeUser: true,
    includeCharacter: true,
    includeName: true,
};

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
            if (!message || message.is_system || message.mes === '...' || !String(message.mes ?? '').trim()) {
                return false;
            }
            return true;
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

function buildSpeechText(rangeMessages) {
    const settings = getSettings();
    return rangeMessages.map(({ message }) => {
        const text = stripHtml(message?.extra?.display_text || message?.mes).trim();
        if (!settings.includeName) {
            return text;
        }
        const name = String(message?.name || (message?.is_user ? 'User' : 'Assistant')).trim();
        return `${name}: ${text}`;
    }).filter(Boolean).join('\n\n');
}

async function speakText(text) {
    const speakCommand = SlashCommandParser.commands.speak || SlashCommandParser.commands.tts || SlashCommandParser.commands.narrate;
    if (!speakCommand) {
        toastr.warning('TTS command is not available. Enable the SillyTavern TTS extension first.');
        return false;
    }

    await speakCommand.callback({}, text);
    return true;
}

async function speakRange(from, to) {
    const rangeMessages = getRangeMessages(from, to);
    if (!rangeMessages.length) {
        toastr.info('No matching messages in that range.');
        return '';
    }

    const text = buildSpeechText(rangeMessages);
    if (!text) {
        toastr.info('Selected messages have no readable text.');
        return '';
    }

    const ok = await speakText(text);
    if (ok) {
        toastr.success(`Narrating messages ${Math.min(from, to)}-${Math.max(from, to)}.`);
    }
    return text;
}

function stopSpeaking() {
    cancelTtsPlay();
    window.speechSynthesis?.cancel?.();
    document.querySelectorAll('audio').forEach(audio => {
        audio.pause();
        audio.currentTime = 0;
    });
    toastr.info('Narration stopped.');
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
                <span>TTS Range</span>
                <button id="st_tts_range_close" class="menu_button fa-solid fa-xmark" title="Close"></button>
            </div>
            <div class="sttrc-row">
                <label for="st_tts_range_from">From</label>
                <input id="st_tts_range_from" class="text_pole" type="number" min="1" step="1">
                <label for="st_tts_range_to">To</label>
                <input id="st_tts_range_to" class="text_pole" type="number" min="1" step="1">
            </div>
            <div class="sttrc-total">Messages available: <span id="st_tts_range_total">0</span></div>
            <label class="checkbox_label sttrc-check">
                <input id="st_tts_range_include_user" type="checkbox">
                <span>User messages</span>
            </label>
            <label class="checkbox_label sttrc-check">
                <input id="st_tts_range_include_character" type="checkbox">
                <span>Character messages</span>
            </label>
            <label class="checkbox_label sttrc-check">
                <input id="st_tts_range_include_name" type="checkbox">
                <span>Read speaker names</span>
            </label>
            <div class="sttrc-actions">
                <button id="st_tts_range_play" class="menu_button fa-solid fa-play" title="Narrate range"></button>
                <button id="st_tts_range_latest" class="menu_button fa-solid fa-forward-step" title="Use latest message"></button>
                <button id="st_tts_range_stop" class="menu_button fa-solid fa-stop" title="Stop narration"></button>
                <button id="st_tts_range_refresh" class="menu_button fa-solid fa-rotate" title="Refresh count"></button>
            </div>
        </div>
    `);

    $('body').append(panel);
    $('#extensionsMenu').append(`
        <div id="st_tts_range_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-headphones-simple extensionsMenuExtensionButton" title="TTS Range Control"></div>
            <span>TTS Range</span>
        </div>
    `);

    $('#st_tts_range_button').on('click', openPanel);
    $('#st_tts_range_close').on('click', () => $('#st_tts_range_panel').addClass('sttrc-hidden'));
    $('#st_tts_range_refresh').on('click', updateStatus);
    $('#st_tts_range_stop').on('click', stopSpeaking);
    $('#st_tts_range_latest').on('click', () => {
        const total = getNarratableMessages().length || 1;
        const settings = getSettings();
        settings.from = total;
        settings.to = total;
        saveSettings();
        updateStatus();
    });
    $('#st_tts_range_play').on('click', async () => {
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
                description: 'First message number to narrate, starting at 1',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'to',
                description: 'Last message number to narrate, starting at 1',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: true,
            }),
        ],
        helpString: `
            <div>Narrate a range of messages in the current chat.</div>
            <div>Message numbers start at 1 and skip hidden system messages.</div>
            <div><strong>Example:</strong> <code>/tts-range from=3 to=8</code></div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tts-range-stop',
        callback: () => {
            stopSpeaking();
            return '';
        },
        helpString: '<div>Stops current narration playback.</div>',
    }));
}

jQuery(() => {
    getSettings();
    createPanel();
    registerSlashCommands();
    updateStatus();
});
