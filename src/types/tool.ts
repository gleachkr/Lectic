type StringSchema = {
    type: "string",
    description: string
    enum? : string[] 
}

type BooleanSchema = {
    type: "boolean",
    description: string
}

type NumberSchema = {
    type: "number",
    description: string
    enum? : any[] // undertyped for compatibility with ollama
    minimum? : number 
    maximum? : number
}

type IntegerSchema = {
    type: "integer",
    description: string
    enum? : any[] // undertyped for compatibility with ollama
    minimum? : number 
    maximum? : number
}

type ArraySchema = {
    type: "array",
    description: string
    items: JSONSchema
}

type ObjectSchema = {
    type: "object",
    description: string
    properties: { [key : string] : JSONSchema }
}

export type JSONSchema = StringSchema 
                | NumberSchema 
                | IntegerSchema 
                | BooleanSchema 
                | ArraySchema
                | ObjectSchema

export abstract class Tool {
    abstract name: string
    abstract description: string
    abstract parameters: { [_ : string] : JSONSchema }
    abstract required? : string[]
    abstract call (arg : any) : Promise<string>

    register() {
        if (this.name in Tool.registry) {
            throw Error("Two tools were given the same name. Check the tool section of your YAML header.") 
        } else {
            Tool.registry[this.name] = this
        }
    }

    static registry : { [key: string] : Tool } = {}
}

export type ToolCall = { args : { [key : string] : any }, result : string }

export function serializeCall(tool: Tool, {args, result } : ToolCall) : string {
    let values = [] 
    for (const key in tool.parameters) {
        values.push(`<${key}>${serialize(args[key], tool.parameters[key])}</${key}>`)
    }

    return `<tool-call with="${tool.name}">\n` +
        `<arguments>${values.join("\n")}</arguments>\n` +
        `<result>${result}</result>\n` +
    `</tool-call>`
}

export function deserializeCall(tool: Tool, serialized : string) 
    : ToolCall | null {
    const inner = /^<tool-call with=".*?">([\s\S]*)<\/tool-call>$/.exec(serialized.trim())
    if (!inner) return null
    let [argstring, result] = extractElements(inner[1])
    argstring = `<object>${unwrap(argstring, "arguments")}</object>`
    result = unwrap(result, "result")
    const argschema = {
        type: "object" as const,
        description: "tool call parameters",
        properties: tool.parameters
    }
    const args = deserialize(argstring, argschema)
    return {args, result}
}

export function getSerializedCallName(call : string) : string | null {
    const result = /^<tool-call with="(.*?)">[\s\S]*<\/tool-call>$/.exec(call.trim())
    return result && result[1]
}

export function isSerializedCall(call : string) : boolean {
    const result = /^<tool-call with=".*?">[\s\S]*<\/tool-call>$/.test(call.trim())
    return result
}

export function serialize(arg: any, schema: JSONSchema): string {
    switch (schema.type) {
        case "string":
            if (typeof arg !== "string" || (schema.enum && !schema.enum.includes(arg))) {
                throw new Error(`Invalid string value: ${arg}`);
            }
            return arg;

        case "boolean":
            if (typeof arg !== "boolean") {
                throw new Error(`Invalid boolean value: ${arg}`);
            }
            return arg.toString();

        case "number":
            if (typeof arg !== "number" || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error(`Invalid number value: ${arg}`);
            }
            return arg.toString();

        case "integer":
            if (!Number.isInteger(arg) || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error(`Invalid integer value: ${arg}`);
            }
            return arg.toString();

        case "array":
            if (!Array.isArray(arg)) {
                throw new Error(`Invalid array value: ${arg}`);
            }
            return `<array>${arg.map(item => `<item>${serialize(item, schema.items)}</item>`).join('')}</array>`;

        case "object":
            if (typeof arg !== "object" || Array.isArray(arg)) {
                throw new Error(`Invalid object value: ${arg}`);
            }
            const properties = schema.properties;
            return `<object>${Object.keys(properties)
                    .map(key => {
                        if (!(key in arg)) throw new Error(`Missing property: ${key}`);
                        return `<${key}>${serialize(arg[key], properties[key])}</${key}>`;
                    }).join('')}</object>`;

        default:
            throw new Error("Unknown schema type");
    }
}

function unwrap(xml: string, tag: string): string {
    const openTag = `<${tag}>`;
    const closeTag = `</${tag}>`;
    if (!xml.startsWith(openTag) || !xml.endsWith(closeTag)) {
        throw new Error(`Invalid serialized ${tag}: ${xml}`);
    }
    return xml.substring(openTag.length, xml.length - closeTag.length);
}

function extractElements(xml: string): string[] {
  const elements: string[] = [];
  let depth = 0;
  let startIdx = -1;
  const tagNamePattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = tagNamePattern.exec(xml)) !== null) {
    if (match[0].startsWith('</')) {
      // Closing tag
      depth--;
      if (depth === 0 && startIdx !== -1) {
        elements.push(xml.substring(startIdx, match.index + match[0].length));
        startIdx = -1;
      } else if (depth < 0) {
        throw new Error(`Unexpected closing tag found: ${match[0]}`);
      }
    } else {
      // Opening tag
      if (depth === 0) startIdx = match.index;
      depth++;
    }
  }

  if (depth !== 0) {
    throw new Error(`Unmatched opening tag`);
  }

  return elements;
}

export function deserialize(xml: string, schema: JSONSchema): any {
    xml = xml.trim();
    switch (schema.type) {
        case "string":
            if (schema.enum && !schema.enum.includes(xml)) {
                throw new Error("Invalid serialized string");
            }
            return xml;

        case "boolean":
            if (xml === "true") return true;
            if (xml === "false") return false;
            throw new Error("Invalid serialized boolean");

        case "number": {
            const num = Number(xml);
            if (isNaN(num) 
                || (schema.minimum !== undefined && num < schema.minimum) 
                || (schema.maximum !== undefined && num > schema.maximum)
                || (schema.enum && !schema.enum.includes(num))) {
                throw new Error("Invalid serialized number");
            }
            return num;
        }

        case "integer": {
            const num = Number(xml);
            if (isNaN(num) 
                || !Number.isInteger(num) 
                || (schema.minimum !== undefined && num < schema.minimum) 
                || (schema.maximum !== undefined && num > schema.maximum)
                || (schema.enum && !schema.enum.includes(num))) {
                throw new Error("Invalid serialized integer");
            }
            return num;
        }

        case "array": {
            const inner = unwrap(xml, "array");
            const items: any[] = [];
            let elements = extractElements(inner)
            for (const item of elements) {
                items.push(deserialize(unwrap(item, "item"), schema.items));
            }
            return items;
        }
        
        case "object": {
            const inner = unwrap(xml, "object");
            const obj: any = {};
            let elements = extractElements(inner)
            for (const element of elements) {
                const keyRegex = new RegExp(`^<(.*?)>`);
                const keyMatch = keyRegex.exec(element)
                if (keyMatch === null) {
                    //should be unreachable
                    throw new Error(`Malformed object key: "${element}" on ${xml}`);
                }
                const key = keyMatch[1]
                if (!(key in schema.properties)) {
                    throw new Error(`Unrecognized property: ${key} on ${xml}`);
                }
                if (key in obj) {
                    throw new Error(`Duplicated property: ${key} on ${xml}`);
                }
                obj[key] = deserialize(unwrap(element, key), schema.properties[key])
            }
            return obj;
        }

        default:
            throw new Error("Unknown schema type");
    }
}
