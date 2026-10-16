interface Fn<In extends unknown[] = unknown[]> {
  readonly Input: unknown[];
  readonly Constraint?: In;
  readonly Output: unknown;
}

type Call<F extends Fn<any>, X extends NonNullable<F["Constraint"]>> = (F & {
  readonly Input: X;
})["Output"] extends infer R
  ? R
  : never;

interface Functor<F extends Fn<[unknown]>> {
  map: <A, B>(fa: Call<F, [A]>, f: (a: A) => B) => Call<F, [B]>;
}

interface Monad<F extends Fn<[unknown]>> extends Partial<Functor<F>> {
  of: <A>(a: A) => Call<F, [A]>;
  flatMap: <A, B>(fa: Call<F, [A]>, f: (a: A) => Call<F, [B]>) => Call<F, [B]>;
}

interface Yieldable<F extends Fn<[unknown]>, A> {
  [Symbol.iterator](): Generator<Call<F, [A]>, A, any>;
  map<B>(f: (a: A) => B): Call<F, [B]>;
  flatMap<B>(f: (a: A) => Call<F, [B]>): Call<F, [B]>;
  ap<B>(fab: Call<F, [(a: A) => B]>): Call<F, [B]>;
  flatten<B>(this: Call<F, [Call<F, [B]>]>): Call<F, [B]>;
}

function yieldable<T extends object, F extends Fn<[unknown]>, A>(
  M: Monad<F>,
  value: T,
): T & Yieldable<F, A> {
  const fa = value as Call<F, [A]>;
  const map = <B>(f: (a: A) => B) => (M.map ? M.map(fa, f) : M.flatMap(fa, (a) => M.of(f(a))));
  return Object.defineProperties(value, {
    [Symbol.iterator]: {
      *value() {
        return (yield fa) as A;
      },
    },
    map: { value: map },
    flatMap: {
      value: <B>(f: (a: A) => Call<F, [B]>) => M.flatMap(fa, f),
    },
    ap: {
      value: <B>(fab: Call<F, [(a: A) => B]>) => M.flatMap(fab, (f) => map(f)),
    },
    flatten: {
      value: <B>() => M.flatMap(fa as Call<F, [Call<F, [B]>]>, (x) => x),
    },
  }) as T & Yieldable<F, A>;
}

function doM<F extends Fn<[unknown]>>(M: Monad<F>) {
  return <R>(body: () => Generator<Call<F, [any]>, R, any>): Call<F, [R]> => {
    const step = (history: unknown[]): Call<F, [R]> => {
      const it = body();
      let res = it.next();
      for (const val of history) res = it.next(val);
      if (res.done) return M.of(res.value);
      return M.flatMap(res.value, (next) => step([...history, next]));
    };
    return step([]);
  };
}

type Maybe<A> = ({ readonly value: A } | {}) & Yieldable<MaybeFn, A>;
const some = <A>(value: A): Maybe<A> => yieldable(maybeMonad, { value });
const none = <A = never>(): Maybe<A> => yieldable(maybeMonad, {});

interface MaybeFn extends Fn<[unknown]> {
  Output: Maybe<this["Input"][0]>;
}

const maybeMonad: Monad<MaybeFn> = {
  of: some,
  flatMap: (fa, f) => ("value" in fa ? f(fa.value) : none()),
};
const maybeDo = doM(maybeMonad);

const result = maybeDo(function* () {
  const x = yield* some(10);
  const y = yield* some("hello");
  return `${y}: ${x * 2}`;
});
console.log(result.map((x) => `${x} 2`));

type Parser<A> = { readonly run: (input: string) => Maybe<readonly [A, string]> } & Yieldable<
  ParserFn,
  A
>;
const parser = <A>(run: (input: string) => Maybe<readonly [A, string]>): Parser<A> =>
  yieldable(parserMonad, { run });

interface ParserFn extends Fn<[unknown]> {
  Output: Parser<this["Input"][0]>;
}

const parserMonad: Monad<ParserFn> = {
  of: (a) => parser((input) => some([a, input])),
  flatMap: (fa, f) => parser((input) => fa.run(input).flatMap(([a, rest]) => f(a).run(rest))),
};
const parserDo = doM(parserMonad);

const str = (s: string): Parser<string> =>
  parser((input) => (input.startsWith(s) ? some([s, input.slice(s.length)]) : none()));

const regex = (re: RegExp): Parser<string> =>
  parser((input) => {
    const m = re.exec(input);
    return m && m.index === 0 ? some([m[0], input.slice(m[0].length)]) : none();
  });

const or = <A>(p1: Parser<A>, p2: Parser<A>): Parser<A> =>
  parser((input) => {
    const res = p1.run(input);
    return "value" in res ? res : p2.run(input);
  });

const many = <A>(p: Parser<A>): Parser<A[]> =>
  parser((input) => {
    const acc: A[] = [];
    let rest = input;
    while (true) {
      const res = p.run(rest);
      if (!("value" in res)) return some([acc, rest]);
      acc.push(res.value[0]);
      rest = res.value[1];
    }
  });

const keyValue = parserDo(function* () {
  const key = yield* regex(/^[a-z]+/);
  yield* str("=");
  const val = yield* or(
    regex(/^\d+/).map(Number),
    str("true").map(() => 1),
  );
  return [key, val] as const;
});

const pairList = many(
  parserDo(function* () {
    const pair = yield* keyValue;
    yield* or(str(","), str(""));
    return pair;
  }),
);

console.log(JSON.stringify(pairList.run("a=10,b=true,c=42!")));
