import * as vscode from "vscode";
import { SidePanelProvider } from "./panel/SidePanelProvider";

const outputChannel = vscode.window.createOutputChannel("Raiview");

export function activate(context: vscode.ExtensionContext) {
  const provider = new SidePanelProvider(context, outputChannel);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidePanelProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("raiview.reviewChanges", () => {
      vscode.window.showInformationMessage(
        "Please use the 'Review Git Changes' button in the extension side panel."
      );
    }),
    outputChannel
  );
}

export function deactivate() {}
