import * as vscode from "vscode";
import { getProvider } from "../providers/index";
import { listReviewerModels } from "../ollama/models";
import { DEFAULT_OLLAMA_URL } from "../constants";

let modelFetchSeq = 0;

export async function fetchModelsForWebview(
  providerName: string,
  apiKey: string | undefined,
  webviewView: vscode.WebviewView
): Promise<void> {
  const seq = ++modelFetchSeq;

  if (providerName === "ollama") {
    const config = vscode.workspace.getConfiguration("raiview");
    const pinned = config.get<string[]>("ollamaModels") ?? [];
    const ollamaUrl = config.get<string>("ollamaUrl") ?? DEFAULT_OLLAMA_URL;
    const isLocal = (() => {
      try { const h = new URL(ollamaUrl).hostname; return h === "localhost" || h === "127.0.0.1" || h === "::1"; }
      catch { return true; }
    })();
    if (pinned.length > 0 && !isLocal) {
      if (seq !== modelFetchSeq) { return; }
      webviewView.webview.postMessage({ type: "models", available: pinned });
      await sendReviewerModelsForWebview(webviewView);
      return;
    }
  }

  const provider = getProvider(providerName);
  if (!provider) {
    webviewView.webview.postMessage({ type: "error", message: `Unknown provider: ${providerName}` });
    return;
  }

  try {
    const models = await provider.listModels(apiKey);
    if (seq !== modelFetchSeq) { return; }
    webviewView.webview.postMessage({ type: "models", available: models });
  } catch (err: any) {
    if (seq !== modelFetchSeq) { return; }
    webviewView.webview.postMessage({
      type: "error",
      message: `Could not fetch models for ${provider.displayName}: ${err.message ?? err}`,
    });
  }

  if (providerName === "ollama") {
    await sendReviewerModelsForWebview(webviewView);
  }
}

export async function sendReviewerModelsForWebview(webviewView: vscode.WebviewView): Promise<void> {
  const ollamaUrl = vscode.workspace.getConfiguration("raiview").get<string>("ollamaUrl") ?? DEFAULT_OLLAMA_URL;
  const models = await listReviewerModels(ollamaUrl);
  webviewView.webview.postMessage({ type: "derivedModelsList", models });
}

