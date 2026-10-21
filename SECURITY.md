# Security policy

## Supported versions

Gnomi has no releases yet. Security fixes go to the `main` branch.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

You can expect an acknowledgement within a week. Once a fix is ready, the advisory is published with credit to you, unless you prefer otherwise.

## What is in scope

Gnomi runs model-chosen actions in real browsers on your machine, so these matter most:

- **Keys and logins.** Provider keys, Figma tokens and recorded login sessions leaking into project folders, logs, reports, prompts or the renderer.
- **Browser containment.** A simulated browser reaching a host the user did not allow, a production host that should be refused, or a payment flow with live keys.
- **Prompt injection.** Page, text or design content that makes a persona act outside its task, read credentials, or change what Gnomi records.
- **The desktop shell.** Ways for page content to reach Node, the engine or the file system through the Electron bridge.

Findings that need a model provider or a website to misbehave on its own, such as a model returning harmful text, are out of scope unless Gnomi turns them into one of the problems above.
