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
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import { buildMacroIndex, previewMacro } from "./macroIndex"
import { buildInterlocutorIndex } from "./interlocutorIndex"
import { dirname } from "path"

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

function parseDirectiveKeyAndBracket(
  lineText: string,
  colonStart: number,
  curCol: number
): { key: string, insideBrackets: boolean, innerStart: number | null, innerPrefix: string } {
  // Extract directive key letters after ':'
  let i = colonStart + 1
  let key = ""
  while (i < lineText.length) {
    const ch = lineText[i]
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) { key += ch; i++ }
    else break
  }
  // Check for brackets
  const bracketIdx = lineText.indexOf('[', colonStart + 1)
  const closeIdx = lineText.indexOf(']', colonStart + 1)
  const inside = bracketIdx !== -1 && bracketIdx < curCol && (closeIdx === -1 || curCol <= closeIdx)
  if (!inside) return { key: key.toLowerCase(), insideBrackets: false, innerStart: null, innerPrefix: "" }
  const innerStart = bracketIdx + 1
  const innerPrefix = lineText.slice(innerStart, curCol)
  return { key: key.toLowerCase(), insideBrackets: true, innerStart, innerPrefix }
}

export function registerLspHandlers(connection: ReturnType<typeof createConnection>) {
  connection.onInitialize((_params: InitializeParams)
    : InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        completionProvider: {
          triggerCharacters: [":", "["]
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
    const uri = new URL(params.textDocument.uri)
    const doc = docs.get(params.textDocument.uri)
    if (!doc) return null

    const docDir = uri.protocol === "file:" 
        ? dirname(uri.pathname) 
        : undefined

    const pos = params.position
    const lineText = getLine(doc.text, pos.line)
    const colonStart = findSingleColonStart(lineText, pos.character)
    if (colonStart === null) return null

    const ctx = parseDirectiveKeyAndBracket(lineText, colonStart, pos.character)

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
        insert: ":ask[$0]",
        detail: ":ask — switch interlocutor for subsequent turns",
        documentation: "Switch the active interlocutor permanently."
      },
      {
        key: "aside",
        label: "aside",
        insert: ":aside[$0]",
        detail: ":aside — address one interlocutor for a single turn",
        documentation: "Temporarily switch interlocutor for this turn only."
      },
      {
        key: "macro",
        label: "macro",
        insert: ":macro[$0]",
        detail: ":macro — expand a named macro",
        documentation: "Insert a macro expansion by name."
      }
    ]

    const items: CompletionItem[] = []

    if (ctx.insideBrackets && (ctx.key === "ask" || ctx.key === "aside" || ctx.key === "macro")) {
      const lowerInner = ctx.innerPrefix.toLowerCase()

      if (ctx.key === "ask" || ctx.key === "aside") {
        const interNames = await buildInterlocutorIndex(doc.text, docDir)
        for (const n of interNames) {
          if (!n.toLowerCase().startsWith(lowerInner)) continue
          const start = ctx.innerStart ?? pos.character
          const textEdit: TextEdit = {
            range: RangeNS.create(
              Position.create(pos.line, start),
              Position.create(pos.line, pos.character)
            ),
            newText: n
          }
          items.push({
            label: n,
            kind: CompletionItemKind.Value,
            detail: "interlocutor",
            insertTextFormat: InsertTextFormat.PlainText,
            textEdit
          })
        }
      } else if (ctx.key === "macro") {
        const macros = await buildMacroIndex(doc.text, docDir)
        for (const m of macros) {
          if (!m.name.toLowerCase().startsWith(lowerInner)) continue
          const start = ctx.innerStart ?? pos.character
          const textEdit: TextEdit = {
            range: RangeNS.create(
              Position.create(pos.line, start),
              Position.create(pos.line, pos.character)
            ),
            newText: m.name
          }
          items.push({
            label: m.name,
            kind: CompletionItemKind.Variable,
            detail: previewMacro(m).detail,
            insertTextFormat: InsertTextFormat.PlainText,
            textEdit
          })
        }
      }
      return items
    }

    // Not inside brackets: suggest directive keywords based on typed prefix
    const prefix = lineText.slice(colonStart + 1, pos.character).toLowerCase()
    for (const d of directives) {
      if (d.key.startsWith(prefix)) {
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
