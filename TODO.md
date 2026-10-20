# TODO

## Observe workspace-folder changes

The repository dropdown is currently refreshed when the review command performs discovery, but it does not react immediately when VS Code workspace folders are added or removed.

Future work:

- Subscribe to `vscode.workspace.onDidChangeWorkspaceFolders`.
- Serialize repository rediscovery with existing review operations.
- Update the webview repository list without running a diff automatically.
- Preserve the current repository when it is still available.
- If the current repository disappears, keep the saved review readable and prompt for another available repository before the next command.
- Cover added folders, removed folders, nested repositories, multi-root workspaces, and an open review panel in host tests.
