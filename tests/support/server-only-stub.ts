/**
 * A stand-in for the `server-only` package.
 *
 * The real package throws unless the importing module is recognised as a React
 * server component, which no test module is. Under a test runner that guard
 * cannot work, so it is replaced with an empty module. The modules it protects
 * are server code by construction here: they are only ever reached through a
 * route handler or the data access layer, and the test asserts the behaviour
 * that matters.
 */
export {};
