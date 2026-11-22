// Copyright 2024-2026 Buf Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  type DescEnum,
  type DescField,
  type DescMessage,
  type DescOneof,
  isMessage,
  protoInt64,
  ScalarType,
} from "@bufbuild/protobuf";
import { isWrapperDesc } from "@bufbuild/protobuf/wkt";

/**
 * A value that does not fit the type of its field.
 */
export interface InitIssue {
  readonly message: string;
  readonly path: ReadonlyArray<PropertyKey>;
}

/**
 * The result of checkInit().
 */
export interface CheckInitResult {
  /**
   * Values that do not fit their field's type. Empty if every value fits.
   */
  readonly issues: InitIssue[];
  /**
   * The init value with 64-bit integers converted to their field's type. This
   * is the given init value if nothing was converted. The given init value is
   * never modified.
   */
  readonly init: object;
}

/**
 * Check that the given init value, or message, matches the types of the
 * message's fields, so that the message created from it can be serialized.
 *
 * The checks follow the conventions of create() in @bufbuild/protobuf: unset
 * fields may be null or undefined, singular wrapper fields outside a oneof
 * group hold the unwrapped value, google.protobuf.Struct fields hold a JSON
 * object, bytes may be given as an array of numbers, and nested messages may
 * be init objects or messages.
 *
 * 64-bit integer fields accept a bigint, a safe integer number, or a string
 * with a decimal integer, like the reflect API does. The value is converted to
 * a bigint, or to a string if the field uses the option `jstype = JS_STRING`.
 * Numbers beyond Number.MAX_SAFE_INTEGER are rejected, because they may have
 * lost precision already.
 */
export function checkInit(desc: DescMessage, init: object): CheckInitResult {
  const ctx: Ctx = { issues: [], seen: new Set() };
  const converted = checkMessage(desc, init, [], ctx);
  return { issues: ctx.issues, init: converted };
}

interface Ctx {
  readonly issues: InitIssue[];
  // Objects on the current path, to detect cycles.
  readonly seen: Set<object>;
}

function addIssue(ctx: Ctx, path: PropertyKey[], message: string): void {
  ctx.issues.push({ message, path });
}

/**
 * Check the fields of a message or message init value. Returns the value with
 * converted fields, copied only if a field was converted.
 */
function checkMessage(
  desc: DescMessage,
  init: object,
  path: PropertyKey[],
  ctx: Ctx,
): object {
  if (ctx.seen.has(init)) {
    addIssue(ctx, path, "must not contain a cycle");
    return init;
  }
  ctx.seen.add(init);
  const record = init as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  for (const member of desc.members) {
    const value = record[member.localName];
    if (value === undefined || value === null) {
      continue;
    }
    const memberPath = [...path, member.localName];
    const converted =
      member.kind == "oneof"
        ? checkOneof(member, value, memberPath, ctx)
        : checkField(member, value, memberPath, ctx);
    if (converted !== value) {
      if (copy === undefined) {
        // Copy own properties only: proto2 messages keep the zero values of
        // unset fields on the prototype, and create() treats missing
        // properties as unset fields. Without $typeName, create() creates a
        // new message from the copy instead of returning it as is.
        const { $typeName: _, ...rest } = record;
        copy = rest;
      }
      copy[member.localName] = converted;
    }
  }
  ctx.seen.delete(init);
  return copy ?? init;
}

function checkField(
  field: DescField,
  value: unknown,
  path: PropertyKey[],
  ctx: Ctx,
): unknown {
  switch (field.fieldKind) {
    case "list":
      return checkList(field, value, path, ctx);
    case "map":
      return checkMap(field, value, path, ctx);
    case "message":
      if (!field.oneof && isWrapperDesc(field.message)) {
        // Singular wrapper fields outside a oneof group are unwrapped.
        const wrapped = field.message.fields[0];
        return checkScalar(
          wrapped.scalar,
          wrapped.longAsString,
          value,
          path,
          ctx,
        );
      }
      return checkMessageValue(field, value, path, ctx);
    case "enum":
      checkEnum(field.enum, value, path, ctx);
      return value;
    case "scalar":
      return checkScalar(field.scalar, field.longAsString, value, path, ctx);
  }
}

function checkOneof(
  oneof: DescOneof,
  value: unknown,
  path: PropertyKey[],
  ctx: Ctx,
): unknown {
  if (!isObject(value)) {
    addIssue(ctx, path, "must be an object");
    return value;
  }
  const adt = value as { case?: unknown; value?: unknown };
  if (adt.case === undefined || adt.case === null) {
    return value;
  }
  const field = oneof.fields.find((f) => f.localName === adt.case);
  if (field === undefined) {
    const cases = oneof.fields.map((f) => `"${f.localName}"`).join(", ");
    addIssue(ctx, [...path, "case"], `must be one of ${cases}`);
    return value;
  }
  const valuePath = [...path, "value"];
  if (adt.value === undefined || adt.value === null) {
    addIssue(ctx, valuePath, "must be set");
    return value;
  }
  const converted = checkSingular(field, adt.value, valuePath, ctx);
  return converted === adt.value
    ? value
    : { case: field.localName, value: converted };
}

function checkList(
  field: DescField & { fieldKind: "list" },
  value: unknown,
  path: PropertyKey[],
  ctx: Ctx,
): unknown {
  if (!Array.isArray(value)) {
    addIssue(ctx, path, "must be an array");
    return value;
  }
  let copy: unknown[] | undefined;
  for (let i = 0; i < value.length; i++) {
    const converted = checkSingular(field, value[i], [...path, i], ctx);
    if (converted !== value[i]) {
      copy ??= value.slice();
      copy[i] = converted;
    }
  }
  return copy ?? value;
}

function checkMap(
  field: DescField & { fieldKind: "map" },
  value: unknown,
  path: PropertyKey[],
  ctx: Ctx,
): unknown {
  if (!isObject(value)) {
    addIssue(ctx, path, "must be an object");
    return value;
  }
  const record = value as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(record)) {
    const entryPath = [...path, key];
    const keyIssue = checkMapKey(field.mapKey, key);
    if (keyIssue !== undefined) {
      addIssue(ctx, entryPath, `key ${keyIssue}`);
      continue;
    }
    const converted = checkSingular(field, record[key], entryPath, ctx);
    if (converted !== record[key]) {
      copy ??= { ...record };
      // Define the property, so that the key "__proto__" is an own property.
      Object.defineProperty(copy, key, {
        value: converted,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return copy ?? value;
}

/**
 * Check a list item, a map value, or a oneof member value. Unlike a singular
 * field outside a oneof group, these hold wrapper messages, not the unwrapped
 * value.
 */
function checkSingular(
  field: DescField,
  value: unknown,
  path: PropertyKey[],
  ctx: Ctx,
): unknown {
  if (field.message !== undefined) {
    return checkMessageValue(field, value, path, ctx);
  }
  if (field.enum !== undefined) {
    checkEnum(field.enum, value, path, ctx);
    return value;
  }
  // Map values are always bigint for 64-bit integers.
  const longAsString = field.fieldKind != "map" && field.longAsString;
  return checkScalar(field.scalar, longAsString, value, path, ctx);
}

function checkMessageValue(
  field: DescField & { message: DescMessage },
  value: unknown,
  path: PropertyKey[],
  ctx: Ctx,
): unknown {
  if (
    field.message.typeName == "google.protobuf.Struct" &&
    field.parent.typeName != "google.protobuf.Value"
  ) {
    // google.protobuf.Struct is represented with JsonObject when used in a
    // field, except when used in google.protobuf.Value.
    if (!isObject(value)) {
      addIssue(ctx, path, "must be a JSON object");
    } else {
      checkJsonObject(value, path, ctx);
    }
    return value;
  }
  if (!isObject(value) || value instanceof Uint8Array) {
    addIssue(ctx, path, "must be an object");
    return value;
  }
  if (isMessage(value) && !isMessage(value, field.message)) {
    addIssue(ctx, path, `must be a message of type ${field.message.typeName}`);
    return value;
  }
  return checkMessage(field.message, value, path, ctx);
}

function checkJsonObject(value: object, path: PropertyKey[], ctx: Ctx): void {
  if (ctx.seen.has(value)) {
    addIssue(ctx, path, "must not contain a cycle");
    return;
  }
  ctx.seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    checkJsonValue(record[key], [...path, key], ctx);
  }
  ctx.seen.delete(value);
}

function checkJsonValue(value: unknown, path: PropertyKey[], ctx: Ctx): void {
  switch (typeof value) {
    case "number":
    case "boolean":
      return;
    case "string":
      if (!isWellFormed(value)) {
        addIssue(ctx, path, "must be valid UTF-8");
      }
      return;
    case "object":
      if (value === null) {
        return;
      }
      if (Array.isArray(value)) {
        if (ctx.seen.has(value)) {
          addIssue(ctx, path, "must not contain a cycle");
          return;
        }
        ctx.seen.add(value);
        for (let i = 0; i < value.length; i++) {
          checkJsonValue(value[i], [...path, i], ctx);
        }
        ctx.seen.delete(value);
        return;
      }
      if (!(value instanceof Uint8Array)) {
        checkJsonObject(value, path, ctx);
        return;
      }
      break;
  }
  addIssue(ctx, path, "must be a JSON value");
}

function checkEnum(
  desc: DescEnum,
  value: unknown,
  path: PropertyKey[],
  ctx: Ctx,
): void {
  if (desc.open) {
    // Open enums accept unknown values, but enum values are always int32.
    checkScalar(ScalarType.INT32, false, value, path, ctx);
    return;
  }
  if (!desc.values.some((v) => v.number === value)) {
    addIssue(ctx, path, `must be a defined value of enum ${desc.typeName}`);
  }
}

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;
const UINT32_MAX = 0xffffffff;
const INT64_RANGE = "-9223372036854775808 and 9223372036854775807";
const UINT64_RANGE = "0 and 18446744073709551615";

/**
 * Check a scalar value. Returns the value, converted to the field's type for
 * 64-bit integers.
 */
function checkScalar(
  scalar: ScalarType,
  longAsString: boolean,
  value: unknown,
  path: PropertyKey[],
  ctx: Ctx,
): unknown {
  let issue: string | undefined;
  switch (scalar) {
    case ScalarType.DOUBLE:
      if (typeof value != "number") {
        issue = "must be a number";
      }
      break;
    case ScalarType.FLOAT:
      if (typeof value != "number") {
        issue = "must be a number";
      } else if (
        // A value too large for a float32 becomes infinity when rounded. NaN
        // and infinity are valid values.
        Number.isFinite(value) &&
        !Number.isFinite(Math.fround(value))
      ) {
        issue = "must be in the range of a 32-bit float";
      }
      break;
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
      if (!isIntegerInRange(value, INT32_MIN, INT32_MAX)) {
        issue = `must be an integer between ${INT32_MIN} and ${INT32_MAX}`;
      }
      break;
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      if (!isIntegerInRange(value, 0, UINT32_MAX)) {
        issue = `must be an integer between 0 and ${UINT32_MAX}`;
      }
      break;
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
      return convertInt64(value, false, longAsString, path, ctx);
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return convertInt64(value, true, longAsString, path, ctx);
    case ScalarType.BOOL:
      if (typeof value != "boolean") {
        issue = "must be a boolean";
      }
      break;
    case ScalarType.STRING:
      if (typeof value != "string") {
        issue = "must be a string";
      } else if (!isWellFormed(value)) {
        issue = "must be valid UTF-8";
      }
      break;
    case ScalarType.BYTES:
      // create() converts an array of numbers to a Uint8Array.
      if (
        !(value instanceof Uint8Array) &&
        !(
          Array.isArray(value) &&
          value.every((b: unknown) => isIntegerInRange(b, 0, 0xff))
        )
      ) {
        issue = "must be a Uint8Array";
      }
      break;
  }
  if (issue !== undefined) {
    addIssue(ctx, path, issue);
  }
  return value;
}

/**
 * Convert a bigint, a safe integer number, or a string with a decimal integer
 * to a bigint, or to a string if the field uses `jstype = JS_STRING`.
 */
function convertInt64(
  value: unknown,
  unsigned: boolean,
  longAsString: boolean,
  path: PropertyKey[],
  ctx: Ctx,
): unknown {
  if (
    typeof value == "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  ) {
    addIssue(
      ctx,
      path,
      `must be a bigint or a string, because numbers beyond ±${Number.MAX_SAFE_INTEGER} lose precision`,
    );
    return value;
  }
  const parsed =
    typeof value == "bigint" ||
    (typeof value == "number" && Number.isInteger(value)) ||
    (typeof value == "string" && /^-?[0-9]+$/.test(value))
      ? parseInt64(value, unsigned)
      : undefined;
  if (parsed === undefined) {
    addIssue(
      ctx,
      path,
      `must be an integer between ${unsigned ? UINT64_RANGE : INT64_RANGE}`,
    );
    return value;
  }
  if (longAsString) {
    const str = parsed.toString();
    return str === value ? value : str;
  }
  return parsed;
}

/**
 * Parse a 64-bit integer, or return undefined if it is out of range.
 */
function parseInt64(
  value: bigint | number | string,
  unsigned: boolean,
): bigint | undefined {
  try {
    return unsigned ? protoInt64.uParse(value) : protoInt64.parse(value);
  } catch (_) {
    return undefined;
  }
}

function checkMapKey(scalar: ScalarType, key: string): string | undefined {
  switch (scalar) {
    case ScalarType.BOOL:
      return key === "true" || key === "false"
        ? undefined
        : 'must be "true" or "false"';
    case ScalarType.STRING:
      return isWellFormed(key) ? undefined : "must be valid UTF-8";
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
      return isCanonicalInteger(key) && parseInt64(key, false) !== undefined
        ? undefined
        : `must be an integer between ${INT64_RANGE}`;
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return isCanonicalInteger(key) && parseInt64(key, true) !== undefined
        ? undefined
        : `must be an integer between ${UINT64_RANGE}`;
    default: {
      // Map keys of the remaining types are 32-bit integers.
      const unsigned =
        scalar === ScalarType.UINT32 || scalar === ScalarType.FIXED32;
      const min = unsigned ? 0 : INT32_MIN;
      const max = unsigned ? UINT32_MAX : INT32_MAX;
      return isCanonicalInteger(key) && isIntegerInRange(Number(key), min, max)
        ? undefined
        : `must be an integer between ${min} and ${max}`;
    }
  }
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value == "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isCanonicalInteger(key: string): boolean {
  return /^(0|-?[1-9][0-9]*)$/.test(key);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value == "object" && !Array.isArray(value);
}

function isWellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch (_) {
    return false;
  }
}
