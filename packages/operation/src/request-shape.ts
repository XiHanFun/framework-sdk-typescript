import {
  defineMember,
  ErrorCode,
  Float64,
  FrameworkError,
  isIntegerNumber,
  JsonMembers,
  type JsonNode,
  JsonPath,
  type JsonValue,
  toJsonValue,
} from '@xihan-framework/primitives';

/**
 * 解码器报告载荷与请求类型不符的位置
 *
 * @remarks
 * 只在 {@link RequestShape.custom} 的解码函数里用：路径用 {@link JsonPath} 从给出的位置往下拼
 *
 * @example
 * ```ts
 * RequestShape.custom((value, path) => {
 *   if (typeof value !== 'string') throw new RequestDecodeError(path);
 *   return new Date(value);
 * });
 * ```
 */
export class RequestDecodeError extends Error {
  /** 错误名 */
  override readonly name = 'RequestDecodeError';
  /** 出错位置的 JSON 路径，以 `$` 开头，如 `$.lines[0].quantity` */
  readonly path: string;

  /**
   * @param path - 出错位置的 JSON 路径
   * @param message - 给开发者看的说明，不上线；缺省为路径
   */
  constructor(path: string, message?: string) {
    super(message ?? path);
    this.path = path;
  }
}

/**
 * 请求类型的形状：调用器按它解码操作载荷（RFC-0011 规则 2，ADR-0236）
 *
 * @remarks
 * 相当于 .NET 的序列化元数据：解码先过共同的 JSON 读取检查，再按形状在文本顺序里找第一处问题，最后构建请求。
 * 规则与 System.Text.Json 的缺省读取选项一致：
 * - 成员名区分大小写；未知成员忽略；数字不从字符串读，字符串也不从数字读。
 * - 整数（{@link RequestShape.int32}、{@link RequestShape.int64}）不接受小数点与指数（`1.0`、`1e2`），超出范围即不符；
 *   浮点（{@link RequestShape.float64}）接受整数写法，上溢为无穷、下溢为 0。
 * - `null`：字符串、数组、对象、字典与任意 JSON 接受，读成 `null`；整数、浮点与布尔（含它们的数组项与字典值）不接受。
 * - 必填（{@link RequestShape.required}）只要求成员出现，值为 `null` 也算出现；缺少时在所在对象结束时报该对象的路径，
 *   所以写在它前面的类型不符先报，嵌套对象里缺少的成员先于外层后面的类型不符。
 *
 * 用静态方法组合，不要继承；`check` 与 `build` 是调用器用的内部入口
 *
 * @example
 * ```ts
 * const CreateOrder = RequestShape.object({
 *   customer: RequestShape.required(RequestShape.string()),
 *   lines: RequestShape.array(RequestShape.object({ quantity: RequestShape.int32() })),
 * });
 * type CreateOrder = RequestShapeType<typeof CreateOrder>;
 * ```
 */
export abstract class RequestShape<T> {
  /**
   * 在文本顺序里找第一处不符
   *
   * @internal
   * @returns 不符处的路径；合形状时为 `undefined`
   */
  abstract check(node: JsonNode, path: string): string | undefined;

  /**
   * 构建请求的值；只在 {@link RequestShape.check} 通过之后调用
   *
   * @internal
   * @throws {@link RequestDecodeError} 自定义形状报告不符时
   */
  abstract build(node: JsonNode, path: string): T;

  /** 字符串；接受 `null` */
  static string(): RequestShape<string | null> {
    return stringShape;
  }

  /** 布尔；不接受 `null` */
  static boolean(): RequestShape<boolean> {
    return booleanShape;
  }

  /** 32 位有符号整数，读成 `number`；不接受 `null`、小数点与指数 */
  static int32(): RequestShape<number> {
    return int32Shape;
  }

  /** 64 位有符号整数，读成 `bigint`；不接受 `null`、小数点与指数 */
  static int64(): RequestShape<bigint> {
    return int64Shape;
  }

  /** 双精度浮点，读成 `number`；接受整数写法，不接受 `null` */
  static float64(): RequestShape<number> {
    return float64Shape;
  }

  /** 任意 JSON，读成 {@link JsonValue}；接受 `null` */
  static json(): RequestShape<JsonValue> {
    return jsonShape;
  }

  /** 数组；接受 `null`，数组项按 `item` 核对 */
  static array<T>(item: RequestShape<T>): RequestShape<T[] | null> {
    return new ArrayShape(item);
  }

  /** 字符串键的字典（JSON 对象），读成普通对象；接受 `null`，成员值按 `value` 核对 */
  static record<T>(value: RequestShape<T>): RequestShape<Record<string, T> | null> {
    return new RecordShape(value);
  }

  /** 对象；接受 `null`，声明的成员按名字核对，未知成员忽略，没有给出的可选成员不出现在结果里 */
  static object<M extends RequestShapeMembers>(members: M): RequestShape<RequestShapeObject<M> | null> {
    return new ObjectShape(members) as RequestShape<RequestShapeObject<M> | null>;
  }

  /** 把对象成员声明为必填：只要求出现，值为 `null` 也算出现 */
  static required<T>(shape: RequestShape<T>): RequiredMember<T> {
    return new RequiredMember(shape);
  }

  /**
   * 自定义的形状：值交给 `decode` 转换
   *
   * @remarks
   * 与 .NET 的自定义转换器一样，形状核对跳过它，在构建时才转换；`decode` 抛出 {@link RequestDecodeError} 时取它的路径，
   * 抛出别的异常时取这个值的路径
   */
  static custom<T>(decode: (value: JsonValue, path: string) => T): RequestShape<T> {
    return new CustomShape(decode);
  }
}

/**
 * 对象的必填成员，用 {@link RequestShape.required} 创建
 */
export class RequiredMember<T> {
  /** 成员的形状 */
  readonly shape: RequestShape<T>;

  /** @internal 用 {@link RequestShape.required} 创建 */
  constructor(shape: RequestShape<T>) {
    if (!(shape instanceof RequestShape)) {
      throw invalid('A required member needs a request shape.');
    }
    this.shape = shape;
    Object.freeze(this);
  }
}

/**
 * 对象形状的成员：名字到形状，必填的用 {@link RequestShape.required} 包起来
 */
export type RequestShapeMembers = Readonly<Record<string, RequestShape<unknown> | RequiredMember<unknown>>>;

/**
 * 对象形状读出的类型：必填成员必有，其余可选
 */
export type RequestShapeObject<M extends RequestShapeMembers> = {
  -readonly [K in keyof M as M[K] extends RequiredMember<unknown> ? K : never]: M[K] extends RequiredMember<infer T>
    ? T
    : never;
} & {
  -readonly [K in keyof M as M[K] extends RequiredMember<unknown> ? never : K]?: M[K] extends RequestShape<infer T>
    ? T
    : never;
};

/**
 * 形状读出的类型
 */
export type RequestShapeType<S> = S extends RequestShape<infer T> ? T : never;

/** 标量：`accepts` 判定节点，`nullable` 决定是否接受 `null` */
class ScalarShape<T> extends RequestShape<T> {
  readonly #accepts: (node: JsonNode) => boolean;
  readonly #nullable: boolean;
  readonly #convert: (node: JsonNode) => T;

  constructor(accepts: (node: JsonNode) => boolean, nullable: boolean, convert: (node: JsonNode) => T) {
    super();
    this.#accepts = accepts;
    this.#nullable = nullable;
    this.#convert = convert;
    Object.freeze(this);
  }

  check(node: JsonNode, path: string): string | undefined {
    if (node === null) {
      return this.#nullable ? undefined : path;
    }
    return this.#accepts(node) ? undefined : path;
  }

  build(node: JsonNode): T {
    return (node === null ? null : this.#convert(node)) as T;
  }
}

const minInt32 = -2_147_483_648;
const maxInt32 = 2_147_483_647;

/** 整数写法读出的节点：安全整数的 number（负零是浮点写法 -0.0）或 bigint */
function isIntegerNode(node: JsonNode): node is number | bigint {
  return typeof node === 'bigint' || (typeof node === 'number' && isIntegerNumber(node));
}

const stringShape = new ScalarShape<string | null>(
  (node) => typeof node === 'string',
  true,
  (node) => node as string,
);
const booleanShape = new ScalarShape<boolean>(
  (node) => typeof node === 'boolean',
  false,
  (node) => node as boolean,
);
const int32Shape = new ScalarShape<number>(
  (node) => typeof node === 'number' && isIntegerNumber(node) && node >= minInt32 && node <= maxInt32,
  false,
  (node) => node as number,
);
// 读出的 bigint 节点都在 64 位范围内，超出的整数写法已经读成浮点
const int64Shape = new ScalarShape<bigint>(isIntegerNode, false, (node) => BigInt(node as number | bigint));
const float64Shape = new ScalarShape<number>(
  (node) => typeof node === 'number' || typeof node === 'bigint' || node instanceof Float64,
  false,
  (node) => (node instanceof Float64 ? node.value : Number(node as number | bigint)),
);
const jsonShape = new ScalarShape<JsonValue>(() => true, true, toJsonValue);

class ArrayShape<T> extends RequestShape<T[] | null> {
  readonly #item: RequestShape<T>;

  constructor(item: RequestShape<T>) {
    super();
    if (!(item instanceof RequestShape)) {
      throw invalid('An array shape needs a request shape for its items.');
    }
    this.#item = item;
    Object.freeze(this);
  }

  check(node: JsonNode, path: string): string | undefined {
    if (node === null) {
      return undefined;
    }
    if (!Array.isArray(node)) {
      return path;
    }
    for (const [index, item] of (node as readonly JsonNode[]).entries()) {
      const problem = this.#item.check(item, JsonPath.index(path, index));
      if (problem !== undefined) {
        return problem;
      }
    }
    return undefined;
  }

  build(node: JsonNode, path: string): T[] | null {
    return node === null
      ? null
      : (node as readonly JsonNode[]).map((item, index) => this.#item.build(item, JsonPath.index(path, index)));
  }
}

class RecordShape<T> extends RequestShape<Record<string, T> | null> {
  readonly #value: RequestShape<T>;

  constructor(value: RequestShape<T>) {
    super();
    if (!(value instanceof RequestShape)) {
      throw invalid('A record shape needs a request shape for its values.');
    }
    this.#value = value;
    Object.freeze(this);
  }

  check(node: JsonNode, path: string): string | undefined {
    if (node === null) {
      return undefined;
    }
    if (!(node instanceof JsonMembers)) {
      return path;
    }
    for (const [name, value] of node.entries) {
      const problem = this.#value.check(value, JsonPath.member(path, name));
      if (problem !== undefined) {
        return problem;
      }
    }
    return undefined;
  }

  build(node: JsonNode, path: string): Record<string, T> | null {
    if (node === null) {
      return null;
    }
    const record: Record<string, T> = {};
    for (const [name, value] of (node as JsonMembers).entries) {
      defineMember(record, name, this.#value.build(value, JsonPath.member(path, name)));
    }
    return record;
  }
}

class ObjectShape extends RequestShape<Record<string, unknown> | null> {
  readonly #members: ReadonlyMap<string, RequestShape<unknown>>;
  readonly #required: readonly string[];

  constructor(members: RequestShapeMembers) {
    super();
    if (typeof members !== 'object' || members === null) {
      throw invalid('An object shape needs its members.');
    }
    const shapes = new Map<string, RequestShape<unknown>>();
    const required: string[] = [];
    for (const [name, member] of Object.entries(members)) {
      if (member instanceof RequiredMember) {
        shapes.set(name, member.shape);
        required.push(name);
      } else if (member instanceof RequestShape) {
        shapes.set(name, member);
      } else {
        throw invalid(`The member '${name}' of an object shape needs a request shape.`);
      }
    }
    this.#members = shapes;
    this.#required = Object.freeze(required);
    Object.freeze(this);
  }

  check(node: JsonNode, path: string): string | undefined {
    if (node === null) {
      return undefined;
    }
    if (!(node instanceof JsonMembers)) {
      return path;
    }
    for (const [name, value] of node.entries) {
      const member = this.#members.get(name);
      // 未知成员忽略；成员名区分大小写
      if (member === undefined) {
        continue;
      }
      const problem = member.check(value, JsonPath.member(path, name));
      if (problem !== undefined) {
        return problem;
      }
    }
    // 缺少必填成员与 System.Text.Json 一样报所在对象的路径
    return this.#required.some((name) => !node.has(name)) ? path : undefined;
  }

  build(node: JsonNode, path: string): Record<string, unknown> | null {
    if (node === null) {
      return null;
    }
    const object: Record<string, unknown> = {};
    for (const [name, value] of (node as JsonMembers).entries) {
      const member = this.#members.get(name);
      if (member !== undefined) {
        defineMember(object, name, member.build(value, JsonPath.member(path, name)));
      }
    }
    return object;
  }
}

class CustomShape<T> extends RequestShape<T> {
  readonly #decode: (value: JsonValue, path: string) => T;

  constructor(decode: (value: JsonValue, path: string) => T) {
    super();
    if (typeof decode !== 'function') {
      throw invalid('A custom request shape needs a decode function.');
    }
    this.#decode = decode;
    Object.freeze(this);
  }

  check(): undefined {
    return undefined;
  }

  build(node: JsonNode, path: string): T {
    try {
      return this.#decode(toJsonValue(node), path);
    } catch (error) {
      if (error instanceof RequestDecodeError) {
        throw error;
      }
      throw new RequestDecodeError(path, error instanceof Error ? error.message : String(error));
    }
  }
}

function invalid(message: string): FrameworkError {
  return new FrameworkError(ErrorCode.InvalidArgument, message);
}
