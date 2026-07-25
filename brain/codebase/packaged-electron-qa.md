# Packaged Electron QA

- Use `code-analysis.patchdesk-electron-tester` for every live app, browser, or packaged-Electron verification.
- The tester owns interactive QA through `agent-browser` over CDP and returns screenshots plus reproducible evidence.
- It must not edit project files, trigger GitHub write confirmation, or make remote writes.
- The primary agent may run static checks and test suites, but must not perform the live UI steps itself.
