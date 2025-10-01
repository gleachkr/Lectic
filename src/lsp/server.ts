import type {
  InitializeParams, InitializeResult,
  DidOpenTextDocumentParams, DidChangeTextDocumentParams,
  DidCloseTextDocumentParams, CompletionParams,
  CompletionItem, TextEdit, Range
} from "vscode-languageserver"
import {
  createConnection, ProposedFeatures, TextDocumentSyncKind,
  CompletionItemKind, InsertTextFormat, Position, Range as RangeNS
} from "vscode-languageserver/node"
import type { MessageReader, MessageWriter } from "vscode-jsonrpc"
import { StreamMessageReader, StreamMessageWriter }
  from "vscode-jsonrpc/node"
import { buildMacroIndex, previewMacro }
  from "./macroIndex"

type Doc = { uri: string, text: string }

const docs = new Map<string, Doc>()

function getLine(text: string, line: number): string {
  const lines = text.split(/\r?\n/)
  return lines[line] ?? ""
}

export function findSingleColonStart(
  lineText: string,
  ch: number
): number | null {
  // Find the last ':' at or before cursor
  let idx = ch - 1
  while (idx >= 0 && lineText[idx] !== ":") idx--
  if (idx < 0 || lineText[idx] !== ":") return null
  // Count run of consecutive ':' around idx
  let left = idx
  while (left - 1 >= 0 && lineText[left - 1] === ":") left--
  let right = idx
  while (right + 1 < lineText.length && lineText[right + 1] === ":") right++
  const runLen = right - left + 1
  if (runLen !== 1) return null
  return idx
}

export function computeReplaceRange(
  line: number, colonCol: number, curCol: number
): Range {
  return RangeNS.create(
    Position.create(line, colonCol),
    Position.create(line, curCol)
  )
}

export function registerLspHandlers(connection: ReturnType<typeof createConnection>) {
  connection.onInitialize((_params: InitializeParams)
    : InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        completionProvider: {
          triggerCharacters: [":"]
        }
      }
    }
  })

  connection.onDidOpenTextDocument((ev: DidOpenTextDocumentParams) => {
    docs.set(ev.textDocument.uri, {
      uri: ev.textDocument.uri,
      text: ev.textDocument.text
    })
  })

  connection.onDidChangeTextDocument((ev: DidChangeTextDocumentParams) => {
    const uri = ev.textDocument.uri
    const changes = ev.contentChanges
    const last = changes[changes.length - 1]
    if (!last) return
    const cur = docs.get(uri)
    if (!cur) {
      docs.set(uri, { uri, text: last.text })
    } else {
      cur.text = last.text
    }
  })

  connection.onDidCloseTextDocument((ev: DidCloseTextDocumentParams) => {
    docs.delete(ev.textDocument.uri)
  })

  connection.onCompletion(async (params: CompletionParams) => {
    const uri = params.textDocument.uri
    const doc = docs.get(uri)
    if (!doc) return null

    const pos = params.position
    const lineText = getLine(doc.text, pos.line)
    const colonStart = findSingleColonStart(lineText, pos.character)
    if (colonStart === null) return null

    const prefix = lineText.slice(colonStart + 1, pos.character)
    const lowerPrefix = prefix.toLowerCase()

    // Static directive suggestions
    type Dir = { key: string, label: string, insert: string, detail: string, documentation: string }
    const directives: Dir[] = [
      {
        key: "cmd",
        label: "cmd",
        insert: ":cmd[${0:command}]",
        detail: ":cmd — run a shell command and insert stdout",
        documentation: "Execute a shell command using the Bun shell and " +
          "inline its stdout into the message."
      },
      {
        key: "reset",
        label: "reset",
        insert: ":reset[]$0",
        detail: ":reset — clear prior conversation context for this turn",
        documentation: "Reset the context window so this turn starts fresh."
      },
      {
        key: "ask",
        label: "ask",
        insert: ":ask[${0:Interlocutor}]",
        detail: ":ask — switch interlocutor for subsequent turns",
        documentation: "Switch the active interlocutor permanently."
      },
      {
        key: "aside",
        label: "aside",
        insert: ":aside[${0:Interlocutor}]",
        detail: ":aside — address one interlocutor for a single turn",
        documentation: "Temporarily switch interlocutor for this turn only."
      }
    ]

    const items: CompletionItem[] = []

    for (const d of directives) {
      if (d.key.startsWith(lowerPrefix)) {
        const textEdit: TextEdit = {
          range: computeReplaceRange(pos.line, colonStart, pos.character),
          newText: d.insert
        }
        items.push({
          label: d.label,
          kind: CompletionItemKind.Keyword,
          detail: d.detail,
          documentation: d.documentation,
          insertTextFormat: InsertTextFormat.Snippet,
          textEdit
        })
      }
    }

    // Macro suggestions
    const macros = await buildMacroIndex(doc.text, uri)
    for (const m of macros) {
      if (!m.name.toLowerCase().startsWith(lowerPrefix)) continue
      const { detail, documentation } = previewMacro(m)
      const textEdit: TextEdit = {
        range: computeReplaceRange(pos.line, colonStart, pos.character),
        newText: `:macro[${m.name}]`
      }
      items.push({
        label: m.name,
        kind: CompletionItemKind.Snippet,
        detail,
        documentation,
        insertTextFormat: InsertTextFormat.PlainText,
        textEdit
      })
    }

    return items
  })
}

export async function startLsp() {
  const connection = createConnection(
    new StreamMessageReader(process.stdin as unknown as NodeJS.ReadableStream),
    new StreamMessageWriter(process.stdout as unknown as NodeJS.WritableStream),
    ProposedFeatures.all
  )
  registerLspHandlers(connection)
  connection.listen()
}

export function startLspWithStreams(reader: MessageReader, writer: MessageWriter) {
  const connection = createConnection(reader, writer, ProposedFeatures.all)
  registerLspHandlers(connection)
  connection.listen()
  return connection
}
