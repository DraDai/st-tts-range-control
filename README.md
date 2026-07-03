# TTS Range Control

SillyTavern third-party extension for narrating a selected message range in the current chat.

## Import

Copy this folder into:

```text
SillyTavern/public/scripts/extensions/third-party/st-tts-range-control
```

With the Docker compose mapping in this repository, you can also place it under:

```text
docker/extensions/st-tts-range-control
```

Then reload SillyTavern and enable **TTS Range Control** in the extensions panel.

## Usage

Open the magic wand / extensions menu and click **TTS Range**. Enter a start and end message number, then press play.

Slash commands:

```stscript
/tts-range from=3 to=8
/tts-range-stop
```

Message numbers start at 1 and skip hidden system messages.
