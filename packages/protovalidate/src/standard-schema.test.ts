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

import * as assert from "node:assert";
import { suite, test } from "node:test";
import { readFileSync } from "node:fs";
import {
  create,
  type DescMessage,
  isFieldSet,
  type Message,
  type MessageInitShape,
  toBinary,
} from "@bufbuild/protobuf";
import {
  BoolValueSchema,
  Int32ValueSchema,
  StringValueSchema,
  UInt32ValueSchema,
} from "@bufbuild/protobuf/wkt";
import { expectTypeOf } from "expect-type";
import { compileMessage } from "@bufbuild/protocompile";
import {
  createStandardSchema,
  createStandardSchemaInit,
  type StandardSchemaV1,
} from "./standard-schema.js";
import { StringRulesSchema } from "./gen/buf/validate/validate_pb.js";

const bufCompileOptions = {
  imports: {
    "buf/validate/validate.proto": readFileSync(
      "proto/buf/validate/validate.proto",
      "utf-8",
    ),
  },
};

void suite("createStandardSchema", () => {
  void test("creates StandardSchemaV1 compliant validator", () => {
    const descMessage = compileMessage(`
      syntax = "proto3";
      message TestMessage {
        string name = 1;
      }`);
    const schema = createStandardSchema(descMessage);
    assert.ok(schema["~standard"]);
    assert.equal(schema["~standard"].version, 1);
    assert.equal(schema["~standard"].vendor, "protovalidate-es");
    assert.equal(typeof schema["~standard"].validate, "function");
  });
  void test("returns SuccessResult for valid message", async () => {
    const descMessage = compileMessage(
      `
      syntax = "proto3";
      import "buf/validate/validate.proto";
      message User {
        string email = 1 [(buf.validate.field).string.email = true];
      }`,
      bufCompileOptions,
    );
    const schema = createStandardSchema(descMessage);
    const message = create(descMessage, { email: "test@example.com" });
    const result = await schema["~standard"].validate(message);
    assert.deepStrictEqual(result, {
      value: message,
    } satisfies StandardSchemaV1.SuccessResult<Message>);
  });
  void test("returns SuccessResult for valid init object", async () => {
    const descMessage = compileMessage(
      `
      syntax = "proto3";
      import "buf/validate/validate.proto";
      message User {
        string email = 1 [(buf.validate.field).string.email = true];
      }`,
      bufCompileOptions,
    );
    const schema = createStandardSchema(descMessage);
    const result = await schema["~standard"].validate({
      email: "test@example.com",
    });
    assert.deepStrictEqual(result, {
      value: create(descMessage, { email: "test@example.com" }),
    } satisfies StandardSchemaV1.SuccessResult<Message>);
  });
  void test("returns FailureResult for invalid init object", async () => {
    const descMessage = compileMessage(
      `
      syntax = "proto3";
      import "buf/validate/validate.proto";
      message User {
        string email = 1 [(buf.validate.field).string.email = true];
      }`,
      bufCompileOptions,
    );
    const schema = createStandardSchema(descMessage);
    const result = await schema["~standard"].validate({
      email: "not-an-email",
    });
    assert.ok(result.issues?.length === 1);
    assert.deepStrictEqual(result.issues, [
      { message: "must be a valid email address", path: ["email"] },
    ]);
  });
  void test("createStandardSchemaInit infers init shape as input type", () => {
    const schema = createStandardSchemaInit(StringRulesSchema);
    expectTypeOf<StandardSchemaV1.InferInput<typeof schema>>().toEqualTypeOf<
      MessageInitShape<typeof StringRulesSchema>
    >();
  });
  void test("returns FailureResult for non-message input", async () => {
    const descMessage = compileMessage(`
      syntax = "proto3";
      message TestMessage {
        string name = 1;
      }`);
    const schema = createStandardSchema(descMessage);

    // Test with null
    let result = await schema["~standard"].validate(null);
    assert.ok(result.issues?.length === 1);
    assert.equal(result.issues[0].message, "Expected an object");

    // Test with string
    result = await schema["~standard"].validate("not an object");
    assert.ok(result.issues?.length === 1);
    assert.equal(result.issues[0].message, "Expected an object");

    // Test with number
    result = await schema["~standard"].validate(42);
    assert.ok(result.issues?.length === 1);
    assert.equal(result.issues[0].message, "Expected an object");
  });
  void test("returns FailureResult for CEL compilation error", async () => {
    const descMessage = compileMessage(
      `
      syntax = "proto3";
      import "buf/validate/validate.proto";
      message BadCEL {
        string value = 1 [(buf.validate.field).cel = {
          id: "bad_cel"
          message: "Invalid CEL"
          expression: "this.invalid.syntax("
        }];
      }`,
      bufCompileOptions,
    );
    const schema = createStandardSchema(descMessage);
    const message = create(descMessage, { value: "test" });
    const result = await schema["~standard"].validate(message);
    assert.ok(result.issues?.length === 1);
    assert.match(result.issues[0].message, /^failed to compile .*/);
  });
  void test("returns FailureResult for invalid message", async () => {
    const descMessage = compileMessage(
      `
      syntax = "proto3";
      import "buf/validate/validate.proto";
      message User {
        string email = 1 [(buf.validate.field).string.email = true];
      }`,
      bufCompileOptions,
    );
    const schema = createStandardSchema(descMessage);
    const message = create(descMessage, { email: "not-an-email" });
    const result = await schema["~standard"].validate(message);
    assert.ok(result.issues?.length === 1);
    assert.equal(result.issues[0].message, "must be a valid email address");
  });
  void test("FailureResult maps multiple violations to issues", async () => {
    const descMessage = compileMessage(
      `
      syntax = "proto3";
      import "buf/validate/validate.proto";
      message User {
        string email = 1 [(buf.validate.field).string.email = true];
        int32 age = 2 [(buf.validate.field).int32 = {gte: 18}];
        string username = 3 [(buf.validate.field).string = {min_len: 3}];
      }`,
      bufCompileOptions,
    );
    const schema = createStandardSchema(descMessage);
    const message = create(descMessage, {
      email: "not-an-email",
      age: 15,
      username: "ab",
    });
    const result = await schema["~standard"].validate(message);
    assert.ok(result.issues);
    assert.deepStrictEqual(result.issues, [
      { message: "must be a valid email address", path: ["email"] },
      { message: "must be greater than or equal to 18", path: ["age"] },
      {
        message: "must be at least 3 characters",
        path: ["username"],
      },
    ]);
  });
  void suite("FailureResult maps violation field path to issue path", () => {
    void test("for message field path", async () => {
      const descMessage = compileMessage(
        `
        syntax = "proto3";
        import "buf/validate/validate.proto";
        message User {
          Address user_address = 2;
          message Address {
            string address_street = 1 [(buf.validate.field).string.min_len = 1];
          }
        }`,
        bufCompileOptions,
      );
      const schema = createStandardSchema(descMessage);
      const message = create(descMessage, {
        name: "John",
        userAddress: {
          addressStreet: "", // Invalid: empty street
        },
      });
      const result = await schema["~standard"].validate(message);
      assert.ok(result.issues?.length === 1);
      assert.deepStrictEqual(result.issues[0].path, [
        "userAddress",
        "addressStreet",
      ]);
    });
    void test("for oneof field path", async () => {
      const descMessage = compileMessage(
        `
        syntax = "proto3";
        import "buf/validate/validate.proto";
        message Contact {
          oneof contact_method {
            option (buf.validate.oneof).required = true;
            string email = 1;
          }
        }`,
        bufCompileOptions,
      );
      const schema = createStandardSchema(descMessage);
      const message = create(descMessage, {});
      const result = await schema["~standard"].validate(message);
      assert.ok(result.issues?.length === 1);
      assert.deepStrictEqual(result.issues[0].path, ["contactMethod"]);
    });
    void test("for oneof member path", async () => {
      const descMessage = compileMessage(
        `
        syntax = "proto3";
        import "buf/validate/validate.proto";
        message Contact {
          oneof contact_method {
            string email_address = 1 [(buf.validate.field).string.email = true];
          }
        }`,
        bufCompileOptions,
      );
      const schema = createStandardSchema(descMessage);
      const message = create(descMessage, {
        contactMethod: {
          case: "emailAddress",
          value: "123",
        },
      });
      const result = await schema["~standard"].validate(message);
      assert.ok(result.issues?.length === 1);
      assert.deepStrictEqual(result.issues[0].path, ["contactMethod", "value"]);
    });
    void test("for repeated field path", async () => {
      const descMessage = compileMessage(
        `
        syntax = "proto3";
        import "buf/validate/validate.proto";
        message EmailList {
          repeated string emails = 1 [(buf.validate.field).repeated = {
            items: {string: {email: true}}
          }];
        }`,
        bufCompileOptions,
      );
      const schema = createStandardSchema(descMessage);
      const message = create(descMessage, {
        emails: ["valid@example.com", "invalid-email", "another@valid.com"],
      });
      const result = await schema["~standard"].validate(message);
      assert.ok(result.issues?.length === 1);
      assert.deepStrictEqual(result.issues[0].path, ["emails", 1]); // Index 1 is invalid
    });
    void test("for map field path", async () => {
      const descMessage = compileMessage(
        `
        syntax = "proto3";
        import "buf/validate/validate.proto";
        message ScoreBoard {
          map<string, int32> scores = 1 [(buf.validate.field).map = {
            values: {int32: {gte: 0, lte: 100}}
          }];
        }
      `,
        bufCompileOptions,
      );
      const schema = createStandardSchema(descMessage);
      const message = create(descMessage, {
        scores: {
          math: 95,
          english: 150, // Invalid: > 100
          science: 85,
        },
      });
      const result = await schema["~standard"].validate(message);
      assert.ok(result.issues?.length === 1);
      assert.deepEqual(result.issues[0].path, ["scores", "english"]);
    });
  });
});

void suite("createStandardSchema checks field types", () => {
  async function validate(desc: DescMessage, value: unknown) {
    return createStandardSchema(desc)["~standard"].validate(value);
  }
  async function assertValid(desc: DescMessage, value: unknown) {
    const result = await validate(desc, value);
    assert.strictEqual(result.issues, undefined);
    assert.ok(result.value);
    // The output can always be serialized.
    toBinary(desc, result.value as Message);
  }
  async function assertIssues(
    desc: DescMessage,
    value: unknown,
    issues: StandardSchemaV1.Issue[],
  ) {
    const result = await validate(desc, value);
    assert.deepStrictEqual(result.issues, issues);
  }

  void suite("rejects the values from issue #218", () => {
    const cases: [DescMessage, unknown, string][] = [
      [UInt32ValueSchema, 1.5, "must be an integer between 0 and 4294967295"],
      [UInt32ValueSchema, -1, "must be an integer between 0 and 4294967295"],
      [
        UInt32ValueSchema,
        2 ** 32,
        "must be an integer between 0 and 4294967295",
      ],
      [
        Int32ValueSchema,
        2 ** 31,
        "must be an integer between -2147483648 and 2147483647",
      ],
      [StringValueSchema, 123, "must be a string"],
      [BoolValueSchema, "yes", "must be a boolean"],
    ];
    for (const [desc, value, message] of cases) {
      void test(`${desc.typeName} ${String(value)}`, async () => {
        await assertIssues(desc, { value }, [{ message, path: ["value"] }]);
      });
    }
  });
  void test("accepts values that fit", async () => {
    await assertValid(UInt32ValueSchema, { value: 0 });
    await assertValid(UInt32ValueSchema, { value: 2 ** 32 - 1 });
    await assertValid(Int32ValueSchema, { value: -(2 ** 31) });
    await assertValid(StringValueSchema, { value: "abc" });
    await assertValid(BoolValueSchema, { value: true });
    await assertValid(UInt32ValueSchema, {});
    await assertValid(UInt32ValueSchema, { value: undefined });
    await assertValid(UInt32ValueSchema, { value: null });
    await assertValid(UInt32ValueSchema, create(UInt32ValueSchema));
  });
  void test("checks a message, not only an init object", async () => {
    const message = create(UInt32ValueSchema);
    message.value = 1.5;
    await assertIssues(UInt32ValueSchema, message, [
      {
        message: "must be an integer between 0 and 4294967295",
        path: ["value"],
      },
    ]);
  });
  void test("reports type issues instead of rule violations", async () => {
    const desc = compileMessage(
      `
      syntax = "proto3";
      import "buf/validate/validate.proto";
      message Form {
        string name = 1 [(buf.validate.field).string.min_len = 3];
        optional uint32 number = 2 [
          (buf.validate.field).required = true,
          (buf.validate.field).uint32.gte = 1,
          (buf.validate.field).uint32.lte = 1000000
        ];
      }`,
      bufCompileOptions,
    );
    await assertIssues(desc, { name: "ab", number: 1.5 }, [
      {
        message: "must be an integer between 0 and 4294967295",
        path: ["number"],
      },
    ]);
    await assertIssues(desc, { name: "abc", number: 0 }, [
      {
        message:
          "must be greater than or equal to 1 and less than or equal to 1000000",
        path: ["number"],
      },
    ]);
    await assertValid(desc, { name: "abc", number: 5 });
  });
  void test("checks scalar types", async () => {
    const desc = compileMessage(`
      syntax = "proto3";
      message Scalars {
        double d = 1;
        float f = 2;
        sint32 s32 = 3;
        fixed32 f32 = 4;
        int64 i64 = 5;
        uint64 u64 = 6;
        int64 i64_str = 7 [jstype = JS_STRING];
        uint64 u64_str = 8 [jstype = JS_STRING];
        bytes b = 9;
        string s = 10;
      }`);
    await assertValid(desc, {
      d: 1.5,
      f: Number.NaN,
      s32: -1,
      f32: 1,
      i64: -(2n ** 63n),
      u64: 2n ** 64n - 1n,
      i64Str: "-9223372036854775808",
      u64Str: "18446744073709551615",
      b: new Uint8Array([1, 2]),
      s: "abc",
    });
    await assertValid(desc, { b: [0, 255] });
    await assertIssues(
      desc,
      {
        d: "1",
        f: 1e39,
        s32: 1.5,
        f32: -1,
        i64: 1.5,
        u64: -1n,
        i64Str: "1e3",
        u64Str: "abc",
        b: [256],
        s: "\uD800",
      },
      [
        { message: "must be a number", path: ["d"] },
        { message: "must be in the range of a 32-bit float", path: ["f"] },
        {
          message: "must be an integer between -2147483648 and 2147483647",
          path: ["s32"],
        },
        {
          message: "must be an integer between 0 and 4294967295",
          path: ["f32"],
        },
        {
          message:
            "must be an integer between -9223372036854775808 and 9223372036854775807",
          path: ["i64"],
        },
        {
          message: "must be an integer between 0 and 18446744073709551615",
          path: ["u64"],
        },
        {
          message:
            "must be an integer between -9223372036854775808 and 9223372036854775807",
          path: ["i64Str"],
        },
        {
          message: "must be an integer between 0 and 18446744073709551615",
          path: ["u64Str"],
        },
        { message: "must be a Uint8Array", path: ["b"] },
        { message: "must be valid UTF-8", path: ["s"] },
      ],
    );
  });
  void test("checks enum values", async () => {
    const open = compileMessage(`
      syntax = "proto3";
      message M {
        E e = 1;
        enum E { E_UNSPECIFIED = 0; E_A = 1; }
      }`);
    await assertValid(open, { e: 1 });
    await assertValid(open, { e: 99 });
    await assertIssues(open, { e: "E_A" }, [
      {
        message: "must be an integer between -2147483648 and 2147483647",
        path: ["e"],
      },
    ]);
    const closed = compileMessage(`
      syntax = "proto2";
      message M {
        optional E e = 1;
        enum E { E_A = 1; }
      }`);
    await assertValid(closed, { e: 1 });
    await assertIssues(closed, { e: 99 }, [
      { message: "must be a defined value of enum M.E", path: ["e"] },
    ]);
  });
  void test("checks nested messages, lists and maps", async () => {
    const desc = compileMessage(`
      syntax = "proto3";
      message M {
        Child child = 1;
        repeated uint32 numbers = 2;
        repeated Child children = 3;
        map<string, uint32> by_name = 4;
        map<int32, Child> by_id = 5;
        map<bool, string> by_flag = 6;
        message Child { uint32 n = 1; }
      }`);
    await assertValid(desc, {
      child: { n: 1 },
      numbers: [1, 2],
      children: [{ n: 1 }],
      byName: { a: 1 },
      byId: { "-1": { n: 1 } },
      byFlag: { true: "a" },
    });
    await assertIssues(
      desc,
      {
        child: { n: -1 },
        numbers: [1, 1.5],
        children: [{ n: 1 }, 5],
        byName: { a: "1" },
        byId: { "1.5": { n: 1 }, "2": { n: -1 } },
        byFlag: { yes: "a" },
      },
      [
        {
          message: "must be an integer between 0 and 4294967295",
          path: ["child", "n"],
        },
        {
          message: "must be an integer between 0 and 4294967295",
          path: ["numbers", 1],
        },
        { message: "must be an object", path: ["children", 1] },
        {
          message: "must be an integer between 0 and 4294967295",
          path: ["byName", "a"],
        },
        {
          message: "must be an integer between 0 and 4294967295",
          path: ["byId", "2", "n"],
        },
        {
          message: "key must be an integer between -2147483648 and 2147483647",
          path: ["byId", "1.5"],
        },
        { message: 'key must be "true" or "false"', path: ["byFlag", "yes"] },
      ],
    );
    await assertIssues(desc, { child: 1, numbers: 1, byName: [] }, [
      { message: "must be an object", path: ["child"] },
      { message: "must be an array", path: ["numbers"] },
      { message: "must be an object", path: ["byName"] },
    ]);
  });
  void test("checks oneof groups", async () => {
    const desc = compileMessage(`
      syntax = "proto3";
      import "google/protobuf/wrappers.proto";
      message M {
        oneof kind {
          uint32 number = 1;
          google.protobuf.UInt32Value wrapped = 2;
        }
      }`);
    await assertValid(desc, { kind: { case: undefined } });
    await assertValid(desc, { kind: { case: "number", value: 1 } });
    await assertValid(desc, { kind: { case: "wrapped", value: { value: 1 } } });
    await assertIssues(desc, { kind: { case: "number", value: -1 } }, [
      {
        message: "must be an integer between 0 and 4294967295",
        path: ["kind", "value"],
      },
    ]);
    // Wrappers in a oneof group are not unwrapped.
    await assertIssues(desc, { kind: { case: "wrapped", value: 1 } }, [
      { message: "must be an object", path: ["kind", "value"] },
    ]);
    await assertIssues(desc, { kind: { case: "other", value: 1 } }, [
      { message: 'must be one of "number", "wrapped"', path: ["kind", "case"] },
    ]);
    await assertIssues(desc, { kind: "number" }, [
      { message: "must be an object", path: ["kind"] },
    ]);
  });
  void test("checks well-known types", async () => {
    const desc = compileMessage(`
      syntax = "proto3";
      import "google/protobuf/struct.proto";
      import "google/protobuf/timestamp.proto";
      import "google/protobuf/wrappers.proto";
      message M {
        google.protobuf.Int64Value wrapped = 1;
        google.protobuf.Struct struct = 2;
        google.protobuf.Timestamp ts = 3;
        repeated google.protobuf.UInt32Value wrappers = 4;
      }`);
    await assertValid(desc, {
      wrapped: 1n,
      struct: { a: [1, "b", null, { c: true }] },
      ts: { seconds: 1n, nanos: 1 },
      wrappers: [{ value: 1 }],
    });
    await assertIssues(
      desc,
      {
        wrapped: 1.5,
        struct: { a: [1n] },
        ts: { seconds: "abc" },
        wrappers: [1],
      },
      [
        {
          message:
            "must be an integer between -9223372036854775808 and 9223372036854775807",
          path: ["wrapped"],
        },
        { message: "must be a JSON value", path: ["struct", "a", 0] },
        {
          message:
            "must be an integer between -9223372036854775808 and 9223372036854775807",
          path: ["ts", "seconds"],
        },
        { message: "must be an object", path: ["wrappers", 0] },
      ],
    );
  });
  void suite("converts 64-bit integers", () => {
    const desc = compileMessage(`
      syntax = "proto3";
      import "google/protobuf/timestamp.proto";
      import "google/protobuf/wrappers.proto";
      message M {
        int64 i64 = 1;
        uint64 u64 = 2;
        int64 i64_str = 3 [jstype = JS_STRING];
        google.protobuf.Int64Value wrapped = 4;
        repeated sint64 list = 5;
        map<string, fixed64> map = 6;
        google.protobuf.Timestamp ts = 7;
        repeated google.protobuf.UInt64Value wrappers = 8;
        oneof kind {
          sfixed64 one = 9;
        }
      }`);
    void test("from safe integer numbers and decimal strings", async () => {
      const init = {
        i64: -5,
        u64: "18446744073709551615",
        i64Str: 7,
        wrapped: "-9223372036854775808",
        list: [1, 2n, "3"],
        map: { a: 1, b: 2n },
        ts: { seconds: 1700000000, nanos: 1 },
        wrappers: [{ value: Number.MAX_SAFE_INTEGER }],
        kind: { case: "one", value: -(2 ** 53 - 1) },
      };
      const before = structuredClone(init);
      const result = await validate(desc, init);
      assert.strictEqual(result.issues, undefined);
      assert.deepStrictEqual(
        result.value,
        create(desc, {
          i64: -5n,
          u64: 18446744073709551615n,
          i64Str: "7",
          wrapped: -9223372036854775808n,
          list: [1n, 2n, 3n],
          map: { a: 1n, b: 2n },
          ts: { seconds: 1700000000n, nanos: 1 },
          wrappers: [{ value: 9007199254740991n }],
          kind: { case: "one", value: -9007199254740991n },
        } as MessageInitShape<typeof desc>),
      );
      toBinary(desc, result.value as Message);
      // The input is not modified.
      assert.deepStrictEqual(init, before);
    });
    void test("to a canonical string for jstype = JS_STRING", async () => {
      for (const i64Str of [7, 7n, "007"]) {
        const result = await validate(desc, { i64Str });
        assert.strictEqual(result.issues, undefined);
        assert.strictEqual(
          (result.value as unknown as { i64Str: string }).i64Str,
          "7",
        );
      }
    });
    void test("in a message", async () => {
      const message = create(desc);
      (message as unknown as { i64: unknown }).i64 = 5;
      const result = await validate(desc, message);
      assert.strictEqual(result.issues, undefined);
      assert.deepStrictEqual(result.value, create(desc, { i64: 5n }));
      assert.strictEqual((message as unknown as { i64: unknown }).i64, 5);
    });
    void test("keeps the presence of fields in a proto2 message", async () => {
      const desc2 = compileMessage(`
        syntax = "proto2";
        message M {
          optional int64 a = 1;
          optional int32 b = 2;
        }`);
      const message = create(desc2);
      (message as unknown as { a: unknown }).a = 5;
      const result = await validate(desc2, message);
      assert.strictEqual(result.issues, undefined);
      const output = result.value as Message;
      assert.strictEqual((output as unknown as { a: unknown }).a, 5n);
      assert.ok(isFieldSet(output, desc2.field.a));
      assert.ok(!isFieldSet(output, desc2.field.b));
    });
    void test("rejects numbers that are not safe integers", async () => {
      const precision =
        "must be a bigint or a string, because numbers beyond ±9007199254740991 lose precision";
      await assertIssues(
        desc,
        {
          i64: 2 ** 53,
          list: [-(2 ** 53)],
          u64: -1,
          i64Str: 1.5,
          wrapped: Number.NaN,
        },
        [
          { message: precision, path: ["i64"] },
          {
            message: "must be an integer between 0 and 18446744073709551615",
            path: ["u64"],
          },
          {
            message:
              "must be an integer between -9223372036854775808 and 9223372036854775807",
            path: ["i64Str"],
          },
          {
            message:
              "must be an integer between -9223372036854775808 and 9223372036854775807",
            path: ["wrapped"],
          },
          { message: precision, path: ["list", 0] },
        ],
      );
    });
  });
  void test("rejects a message of another type", async () => {
    const desc = compileMessage(`
      syntax = "proto3";
      import "google/protobuf/wrappers.proto";
      message M {
        repeated google.protobuf.UInt32Value wrappers = 1;
      }`);
    await assertIssues(desc, { wrappers: [create(Int32ValueSchema)] }, [
      {
        message: "must be a message of type google.protobuf.UInt32Value",
        path: ["wrappers", 0],
      },
    ]);
  });
  void test("rejects a cycle", async () => {
    const desc = compileMessage(`
      syntax = "proto3";
      message M { M child = 1; }`);
    const init: Record<string, unknown> = {};
    init.child = init;
    await assertIssues(desc, init, [
      { message: "must not contain a cycle", path: ["child"] },
    ]);
  });
});
