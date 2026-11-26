import { z } from "zod";

const object = z.record(z.string(), z.unknown());
const strings = z.array(z.string());
const formats = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

interface Budget {
  tools: number;
  optional: number;
  unions: number;
}

function checkBudget({ tools, optional, unions }: Budget): void {
  if (tools > 20 || optional > 24 || unions > 16)
    throw new Error(
      `Strict schema budget exceeded: ${tools} tools, ${optional} optional properties, ${unions} unions`,
    );
}

function convert(input: unknown, path: string, counts: Budget): Record<string, unknown> {
  const node = object.parse(input);
  const out: Record<string, unknown> = {};
  const notes: string[] = [];
  const required = strings.parse(node.required ?? []);
  const types = Array.isArray(node.type) ? strings.parse(node.type) : [node.type];
  if (
    (types.includes("object") || Object.hasOwn(node, "properties")) &&
    node.additionalProperties !== false
  )
    throw new Error(`${path}: object requires additionalProperties: false`);
  for (const [key, value] of Object.entries(node)) {
    switch (key) {
      case "type":
        if (Array.isArray(value)) counts.unions++;
        out.type = value;
        break;
      case "required":
      case "enum":
      case "const":
      case "description":
        out[key] = value;
        break;
      case "additionalProperties":
        if (value !== false) throw new Error(`${path}.additionalProperties must be false`);
        out[key] = false;
        break;
      case "properties": {
        const props = object.parse(value);
        const optional = Object.keys(props).filter((k) => !required.includes(k));
        counts.optional += optional.length;
        out.properties = Object.fromEntries(
          [...required, ...optional].map((k) => [
            k,
            convert(props[k], `${path}.properties.${k}`, counts),
          ]),
        );
        break;
      }
      case "items":
        out.items = convert(value, `${path}.items`, counts);
        break;
      case "oneOf":
        if ("type" in node || "properties" in node)
          throw new Error(`${path}.oneOf conflicts with type or properties`);
        counts.unions++;
        out.anyOf = z
          .array(z.unknown())
          .parse(value)
          .map((v, i) => convert(v, `${path}.oneOf[${i}]`, counts));
        break;
      case "format":
        if (formats.has(z.string().parse(value))) out.format = value;
        break;
      case "discriminator":
        break;
      case "minItems":
        if (value === 0 || value === 1) out.minItems = value;
        else notes.push(`At least ${z.number().parse(value)} items.`);
        break;
      case "maxItems":
        notes.push(`At most ${z.number().parse(value)} items.`);
        break;
      case "minLength":
        notes.push(
          node.maxLength === undefined
            ? `Minimum character count: ${z.number().parse(value)}.`
            : `${z.number().parse(value)} to ${z.number().parse(node.maxLength)} characters.`,
        );
        break;
      case "maxLength":
        if (node.minLength === undefined)
          notes.push(`At most ${z.number().parse(value)} characters.`);
        break;
      case "minimum":
        notes.push(
          node.maximum === undefined
            ? `Must be at least ${z.number().parse(value)}.`
            : `${node.type === "integer" ? "Integer" : "Number"} from ${z.number().parse(value)} to ${z.number().parse(node.maximum)}.`,
        );
        break;
      case "maximum":
        if (node.minimum === undefined) notes.push(`Must be at most ${z.number().parse(value)}.`);
        break;
      case "exclusiveMinimum":
        notes.push(`Must exceed ${z.number().parse(value)}.`);
        break;
      case "exclusiveMaximum":
        notes.push(`Must be less than ${z.number().parse(value)}.`);
        break;
      case "multipleOf":
        notes.push(`Must be a multiple of ${z.number().parse(value)}.`);
        break;
      case "pattern":
        notes.push(`Must match the pattern ${z.string().parse(value)}.`);
        break;
      default:
        throw new Error(`Unsupported schema keyword at ${path}.${key}`);
    }
  }
  if (notes.length) out.description = [node.description, ...notes].filter(Boolean).join(" ");
  return out;
}

export function strictToolSchemas(
  tools: readonly { name: string; input: Record<string, unknown> }[],
) {
  const counts = { tools: tools.length, optional: 0, unions: 0 };
  const result = tools.map(({ name, input }) => {
    const { description, ...body } = input;
    delete body.$schema;
    delete body.title;
    return {
      name,
      description: z.string().min(1).parse(description),
      inputSchemaJson: JSON.stringify(convert(body, name, counts)),
    };
  });
  checkBudget(counts);
  return result;
}
