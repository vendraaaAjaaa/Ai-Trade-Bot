declare namespace jest {
  interface Mock<TArgs extends unknown[] = unknown[], TReturn = unknown> {
    (...args: TArgs): TReturn;
    mockResolvedValue(value: unknown): this;
    mockReturnValue(value: unknown): this;
    mockClear(): this;
  }

  function fn<TArgs extends unknown[] = unknown[], TReturn = unknown>(
    implementation?: (...args: TArgs) => TReturn,
  ): Mock<TArgs, TReturn>;

  function mock(moduleName: string, factory?: () => unknown): void;
}

interface JestMatchers {
  not: JestMatchers;
  rejects: JestMatchers;
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeCloseTo(expected: number, precision?: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toHaveBeenCalled(): void;
  toHaveBeenCalledTimes(expected: number): void;
  toHaveBeenCalledWith(...expected: unknown[]): void;
  toHaveLength(expected: number): void;
  toMatch(expected: RegExp | string): void;
  toThrow(expected?: RegExp | string | Error): void;
}

declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => void | Promise<void>): void;
declare function beforeEach(fn: () => void | Promise<void>): void;
declare function expect(actual: unknown): JestMatchers;

declare namespace expect {
  function anything(): unknown;
  function any(constructor: unknown): unknown;
}
