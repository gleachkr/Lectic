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

export type Tool = {
    name: string
    description: string
    parameters: { [_ : string] : JSONSchema }
    required? : string[]
    call (arg : any) : Promise<string>
}

export function serialize(arg: any, schema: JSONSchema): string {
    switch (schema.type) {
        case "string":
            if (typeof arg !== "string" || (schema.enum && !schema.enum.includes(arg))) {
                throw new Error("Invalid string value");
            }
            return `<string>${arg}</string>`;
        
        case "boolean":
            if (typeof arg !== "boolean") {
                throw new Error("Invalid boolean value");
            }
            return `<boolean>${arg}</boolean>`;
        
        case "number":
            if (typeof arg !== "number" || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error("Invalid number value");
            }
            return `<number>${arg}</number>`;
        
        case "integer":
            if (!Number.isInteger(arg) || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error("Invalid integer value");
            }
            return `<integer>${arg}</integer>`;

        case "array":
            if (!Array.isArray(arg)) {
                throw new Error("Invalid array value");
            }
            return `<array>${arg.map(item => serialize(item, schema.items)).join('')}</array>`;

        case "object":
            if (typeof arg !== "object" || Array.isArray(arg)) {
                throw new Error("Invalid object value");
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
        const errorMap: { [key: string]: string } = {
            string: "Invalid serialized string",
            boolean: "Invalid serialized boolean",
            number: "Invalid serialized number",
            integer: "Invalid serialized integer",
            array: "Invalid serialized array",
            object: "Invalid serialized object"
        };
        throw new Error(errorMap[tag] || "Invalid serialized value");
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
        case "string": {
            const inner = unwrap(xml, "string");
            if (schema.enum && !schema.enum.includes(inner)) {
                throw new Error("Invalid serialized string");
            }
            return inner;
        }
        case "boolean": {
            const inner = unwrap(xml, "boolean");
            if (inner === "true") return true;
            if (inner === "false") return false;
            throw new Error("Invalid serialized boolean");
        }
        case "number": {
            const inner = unwrap(xml, "number");
            const num = Number(inner);
            if (isNaN(num) 
                || (schema.minimum !== undefined && num < schema.minimum) 
                || (schema.maximum !== undefined && num > schema.maximum)
                || (schema.enum && !schema.enum.includes(num))
               ) { throw new Error("Invalid serialized number"); }
            return num;
        }
        case "integer": {
            const inner = unwrap(xml, "integer");
            const num = Number(inner);
            if (isNaN(num) 
                || !Number.isInteger(num) 
                || (schema.minimum !== undefined && num < schema.minimum) 
                || (schema.maximum !== undefined && num > schema.maximum)
                || (schema.enum && !schema.enum.includes(num))
               ) { throw new Error("Invalid serialized integer"); }
            return num;
        }
        case "array": {
          const inner = unwrap(xml, "array");
          const items: any[] = [];
          const elements = extractElements(inner);
          elements.forEach(element => {
            const item = deserialize(element, schema.items);
            items.push(item);
          });
          return items;
        }
        case "object": {
            const inner = unwrap(xml, "object");
            const obj: any = {};
            for (const key in schema.properties) {
                const keyRegex = new RegExp(`<${key}>([\\s\\S]*?)</${key}>`);
                const keyMatch = inner.match(keyRegex);
                if (!keyMatch) {
                    throw new Error(`Missing serialized property: ${key} on ${xml}`);
                }
                // keyMatch[1] is the inner content which should be a valid serialization 
                // of the property value (including its own type tag)
                obj[key] = deserialize(keyMatch[1], schema.properties[key]);
            }
            return obj;
        }
        default: throw new Error("Unknown schema type");
    }
}
