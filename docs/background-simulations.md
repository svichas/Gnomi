# Background simulations

Start a simulation from a project's Review step, then continue editing or open another project. Each project can have one active simulation, and different projects can run concurrently. The settings and audience captured when a run starts remain its inputs, even if you edit the project afterward. Budgets and concurrency limits apply to each run.

The **Simulations** pill stays at the bottom right throughout the app. It starts collapsed and expands upward in place. It lists every run started in the current app session, with active runs first, including runs that need attention, completed reports, stopped runs and interrupted runs. Open a row to return to that project's simulation or report; its stop control affects only that run.

The session list survives a renderer reload. Quitting Gnomi stops active simulations and ends the session; saved history and reports remain in their projects. Folder operations such as delete, rename, duplicate and export require the affected project's run to finish or stop. Recording a login and pending setup tasks must finish before switching projects.

The engine retains databases only for the selected project and projects with active runs. Events and stop requests include a project directory because run IDs are local to a project. The session list keeps lightweight summaries, not another copy of event logs or model transcripts. A run is marked completed only after its report has been saved.

Verification: `npm test`, `npm run typecheck`, `npm run smoke:background -w @gnomi/app`, `npm run smoke:projects -w @gnomi/app`, and `npm run smoke:completion -w @gnomi/app`. The background smoke uses disposable projects and scripted models, checks navigation and targeted stops, and captures the pill at 320, 768, 1024 and 1440 pixels.
