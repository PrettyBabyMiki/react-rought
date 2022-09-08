/* eslint-disable jest/valid-title */
import type {
  ActionFunction,
  AgnosticDataRouteObject,
  AgnosticRouteMatch,
  Fetcher,
  RouterFetchOptions,
  HydrationState,
  InitialEntry,
  LoaderFunction,
  Router,
  RouterNavigateOptions,
  StaticHandler,
  StaticHandlerContext,
} from "../index";
import {
  createMemoryHistory,
  createRouter,
  unstable_createStaticHandler as createStaticHandler,
  defer,
  ErrorResponse,
  IDLE_FETCHER,
  IDLE_NAVIGATION,
  json,
  matchRoutes,
  redirect,
  parsePath,
} from "../index";

// Private API
import type { TrackedPromise } from "../utils";
import { AbortedDeferredError } from "../utils";

///////////////////////////////////////////////////////////////////////////////
//#region Types and Utils
///////////////////////////////////////////////////////////////////////////////

// Routes passed into setup() should just have a boolean for loader/action
// indicating they want a stub
type TestRouteObject = Pick<
  AgnosticDataRouteObject,
  "id" | "index" | "path" | "shouldRevalidate"
> & {
  loader?: boolean;
  action?: boolean;
  hasErrorBoundary?: boolean;
  children?: TestRouteObject[];
};

// Enhanced route objects are what is passed to the router for testing, as they
// have been enhanced with stubbed loaders and actions
type EnhancedRouteObject = Omit<
  TestRouteObject,
  "loader" | "action" | "children"
> & {
  loader?: LoaderFunction;
  action?: ActionFunction;
  children?: EnhancedRouteObject[];
};

// A helper that includes the Deferred and stubs for any loaders/actions for the
// route allowing fine-grained test execution
type InternalHelpers = {
  navigationId: number;
  dfd: ReturnType<typeof createDeferred>;
  stub: jest.Mock;
  _signal?: AbortSignal;
};

type Helpers = InternalHelpers & {
  get signal(): AbortSignal;
  resolve: (d: any) => Promise<void>;
  reject: (d: any) => Promise<void>;
  redirect: (
    href: string,
    status?: number,
    headers?: Record<string, string>,
    shims?: string[]
  ) => Promise<NavigationHelpers>;
  redirectReturn: (
    href: string,
    status?: number,
    headers?: Record<string, string>,
    shims?: string[]
  ) => Promise<NavigationHelpers>;
};

// Helpers returned from a TestHarness.navigate call, allowing fine grained
// control and assertions over the loaders/actions
type NavigationHelpers = {
  navigationId: number;
  loaders: Record<string, Helpers>;
  actions: Record<string, Helpers>;
};

type FetcherHelpers = NavigationHelpers & {
  key: string;
  fetcher: Fetcher;
};

async function tick() {
  await new Promise((r) => setImmediate(r));
}

function invariant(value: boolean, message?: string): asserts value;
function invariant<T>(
  value: T | null | undefined,
  message?: string
): asserts value is T;
function invariant(value: any, message?: string) {
  if (value === false || value === null || typeof value === "undefined") {
    console.warn("Test invariant failed:", message);
    throw new Error(message);
  }
}

function createDeferred() {
  let resolve: (val?: any) => Promise<void>;
  let reject: (error?: Error) => Promise<void>;
  let promise = new Promise((res, rej) => {
    resolve = async (val: any) => {
      res(val);
      await tick();
      await promise;
    };
    reject = async (error?: Error) => {
      rej(error);
      await promise.catch(() => tick());
    };
  });
  return {
    promise,
    //@ts-ignore
    resolve,
    //@ts-ignore
    reject,
  };
}

function createFormData(obj: Record<string, string>): FormData {
  let formData = new FormData();
  Object.entries(obj).forEach((e) => formData.append(e[0], e[1]));
  return formData;
}

function isRedirect(result: any) {
  return (
    result instanceof Response && result.status >= 300 && result.status <= 399
  );
}

interface CustomMatchers<R = unknown> {
  trackedPromise(data?: any, error?: any, aborted?: boolean): R;
}

declare global {
  namespace jest {
    interface Expect extends CustomMatchers {}
    interface Matchers<R> extends CustomMatchers<R> {}
    interface InverseAsymmetricMatchers extends CustomMatchers {}
  }
}

// Custom matcher for asserting deferred promise results inside of `toEqual()`
//  - expect.trackedPromise()                  =>  pending promise
//  - expect.trackedPromise(value)             =>  promise resolved with `value`
//  - expect.trackedPromise(null, error)       =>  promise rejected with `error`
//  - expect.trackedPromise(null, null, true)  =>  promise aborted
expect.extend({
  trackedPromise(received, data, error, aborted = false) {
    let promise = received as TrackedPromise;
    let isTrackedPromise =
      promise instanceof Promise && promise._tracked === true;

    if (data != null) {
      let dataMatches = promise._data === data;
      return {
        message: () => `expected ${received} to be a resolved deferred`,
        pass: isTrackedPromise && dataMatches,
      };
    }

    if (error != null) {
      let errorMatches =
        error instanceof Error
          ? promise._error.toString() === error.toString()
          : promise._error === error;
      return {
        message: () => `expected ${received} to be a rejected deferred`,
        pass: isTrackedPromise && errorMatches,
      };
    }

    if (aborted) {
      let errorMatches = promise._error instanceof AbortedDeferredError;
      return {
        message: () => `expected ${received} to be an aborted deferred`,
        pass: isTrackedPromise && errorMatches,
      };
    }

    return {
      message: () => `expected ${received} to be a pending deferred`,
      pass:
        isTrackedPromise &&
        promise._data === undefined &&
        promise._error === undefined,
    };
  },
});

// Router created by setup() - used for automatic cleanup
let currentRouter: Router | null = null;
// A set of to-be-garbage-collected Deferred's to clean up at the end of a test
let gcDfds = new Set<ReturnType<typeof createDeferred>>();

type SetupOpts = {
  routes: TestRouteObject[];
  basename?: string;
  initialEntries?: InitialEntry[];
  initialIndex?: number;
  hydrationData?: HydrationState;
};

function setup({
  routes,
  basename,
  initialEntries,
  initialIndex,
  hydrationData,
}: SetupOpts) {
  let guid = 0;
  // Global "active" helpers, keyed by navType:guid:loaderOrAction:routeId.
  // For example, the first navigation for /parent/foo would generate:
  //   navigation:1:action:parent -> helpers
  //   navigation:1:action:foo -> helpers
  //   navigation:1:loader:parent -> helpers
  //   navigation:1:loader:foo -> helpers
  //
  let activeHelpers = new Map<string, InternalHelpers>();
  // "Active" flags to indicate which helpers should be used the next time a
  // router calls an action or loader internally.
  let activeActionType: "navigation" | "fetch" = "navigation";
  let activeLoaderType: "navigation" | "fetch" = "navigation";
  let activeLoaderNavigationId = guid;
  let activeActionNavigationId = guid;
  let activeLoaderFetchId = guid;
  let activeActionFetchId = guid;

  // Enhance routes with loaders/actions as requested that will call the
  // active navigation loader/action
  function enhanceRoutes(_routes: TestRouteObject[]) {
    return _routes.map((r) => {
      let enhancedRoute: EnhancedRouteObject = {
        ...r,
        loader: undefined,
        action: undefined,
        children: undefined,
      };
      if (r.loader) {
        enhancedRoute.loader = (args) => {
          let navigationId =
            activeLoaderType === "fetch"
              ? activeLoaderFetchId
              : activeLoaderNavigationId;
          let helperKey = `${activeLoaderType}:${navigationId}:loader:${r.id}`;
          let helpers = activeHelpers.get(helperKey);
          invariant(helpers, `No helpers found for: ${helperKey}`);
          helpers.stub(args);
          helpers._signal = args.request.signal;
          return helpers.dfd.promise;
        };
      }
      if (r.action) {
        enhancedRoute.action = (args) => {
          let type = activeActionType;
          let navigationId =
            activeActionType === "fetch"
              ? activeActionFetchId
              : activeActionNavigationId;
          let helperKey = `${activeActionType}:${navigationId}:action:${r.id}`;
          let helpers = activeHelpers.get(helperKey);
          invariant(helpers, `No helpers found for: ${helperKey}`);
          helpers.stub(args);
          helpers._signal = args.request.signal;
          return helpers.dfd.promise.then(
            (result) => {
              // After a successful non-redirect action, ensure we call the right
              // loaders as a follow up.  In the case of a redirect, ths navigation
              // is aborted and we will use whatever new navigationId the redirect
              // already assigned
              if (!isRedirect(result)) {
                if (type === "navigation") {
                  activeLoaderType = "navigation";
                  activeLoaderNavigationId = navigationId;
                } else {
                  activeLoaderType = "fetch";
                  activeLoaderFetchId = navigationId;
                }
              }
              return result;
            },
            (result) => {
              // After a non-redirect rejected navigation action, we may still call
              // ancestor loaders so set the right values to ensure we trigger the
              // right ones.
              if (type === "navigation" && !isRedirect(result)) {
                activeLoaderType = "navigation";
                activeLoaderNavigationId = navigationId;
              }
              return Promise.reject(result);
            }
          );
        };
      }
      if (r.children) {
        enhancedRoute.children = enhanceRoutes(r.children);
      }
      return enhancedRoute;
    });
  }

  let history = createMemoryHistory({ initialEntries, initialIndex });
  let enhancedRoutes = enhanceRoutes(routes);
  jest.spyOn(history, "push");
  jest.spyOn(history, "replace");
  currentRouter = createRouter({
    basename,
    history,
    routes: enhancedRoutes,
    hydrationData,
  }).initialize();

  function getRouteHelpers(
    routeId: string,
    navigationId: number,
    addHelpers: (routeId: string, helpers: InternalHelpers) => void
  ): Helpers {
    // Internal methods we need access to from the route loader execution
    let internalHelpers: InternalHelpers = {
      navigationId,
      dfd: createDeferred(),
      stub: jest.fn(),
    };
    // Allow the caller to store off the helpers in the right spot so eventual
    // executions by the router can access the right ones
    addHelpers(routeId, internalHelpers);
    gcDfds.add(internalHelpers.dfd);

    async function _redirect(
      isRejection: boolean,
      href: string,
      status = 301,
      headers = {},
      shims: string[] = []
    ) {
      let redirectNavigationId = ++guid;
      activeLoaderType = "navigation";
      activeLoaderNavigationId = redirectNavigationId;
      let helpers = getNavigationHelpers(href, redirectNavigationId);

      // Since a redirect kicks off and awaits a new navigation we can't shim
      // these _after_ the redirect, so we allow the caller to pass in loader
      // shims with the redirect
      shims.forEach((routeId) => {
        invariant(
          !helpers.loaders[routeId],
          "Can't overwrite existing helpers"
        );
        helpers.loaders[routeId] = getRouteHelpers(
          routeId,
          redirectNavigationId,
          (routeId, helpers) =>
            activeHelpers.set(
              `navigation:${redirectNavigationId}:loader:${routeId}`,
              helpers
            )
        );
      });

      try {
        let redirectResponse = redirect(href, { status, headers });
        if (isRejection) {
          // @ts-ignore
          await internalHelpers.dfd.reject(redirectResponse);
        } else {
          await internalHelpers.dfd.resolve(redirectResponse);
        }
        await tick();
      } catch (e) {}
      return helpers;
    }

    let routeHelpers: Helpers = {
      // @ts-expect-error
      get signal() {
        return internalHelpers._signal;
      },
      // Note: This spread has to come _after_ the above getter, otherwise
      // we lose the getter nature of it somewhere in the babel/typescript
      // transform.  Doesn't seem ot be an issue in ts-jest but that's a
      // bit large of a change to look into at the moment
      ...internalHelpers,
      // Public APIs only needed for test execution
      async resolve(value) {
        await internalHelpers.dfd.resolve(value);
      },
      async reject(value) {
        try {
          await internalHelpers.dfd.reject(value);
        } catch (e) {}
      },
      async redirect(href, status = 301, headers = {}, shims = []) {
        return _redirect(true, href, status, headers, shims);
      },
      async redirectReturn(href, status = 301, headers = {}, shims = []) {
        return _redirect(false, href, status, headers, shims);
      },
    };
    return routeHelpers;
  }

  function getHelpers(
    matches: AgnosticRouteMatch<string, AgnosticDataRouteObject>[],
    navigationId: number,
    addHelpers: (routeId: string, helpers: InternalHelpers) => void
  ): Record<string, Helpers> {
    return matches.reduce(
      (acc, m) =>
        Object.assign(acc, {
          [m.route.id]: getRouteHelpers(m.route.id, navigationId, addHelpers),
        }),
      {}
    );
  }

  function getNavigationHelpers(
    href: string,
    navigationId: number
  ): NavigationHelpers {
    let matches = matchRoutes(enhancedRoutes, href);

    // Generate helpers for all route matches that contain loaders
    let loaderHelpers = getHelpers(
      (matches || []).filter((m) => m.route.loader),
      navigationId,
      (routeId, helpers) =>
        activeHelpers.set(
          `navigation:${navigationId}:loader:${routeId}`,
          helpers
        )
    );
    let actionHelpers = getHelpers(
      (matches || []).filter((m) => m.route.action),
      navigationId,
      (routeId, helpers) =>
        activeHelpers.set(
          `navigation:${navigationId}:action:${routeId}`,
          helpers
        )
    );

    return {
      navigationId,
      loaders: loaderHelpers,
      actions: actionHelpers,
    };
  }

  function getFetcherHelpers(
    key: string,
    href: string,
    navigationId: number,
    opts?: RouterNavigateOptions
  ): FetcherHelpers {
    let matches = matchRoutes(enhancedRoutes, href);
    invariant(currentRouter, "No currentRouter available");
    let search = parsePath(href).search || "";
    let hasNakedIndexQuery = new URLSearchParams(search)
      .getAll("index")
      .some((v) => v === "");

    // Let fetcher 404s go right through
    if (!matches) {
      return {
        key,
        navigationId,
        get fetcher() {
          invariant(currentRouter, "No currentRouter available");
          return currentRouter.getFetcher(key);
        },
        loaders: {},
        actions: {},
      };
    }

    let match =
      matches[matches.length - 1].route.index && !hasNakedIndexQuery
        ? matches.slice(-2)[0]
        : matches.slice(-1)[0];

    // If this is an action submission we need loaders for all current matches.
    // Otherwise we should only need a loader for the leaf match
    let activeLoaderMatches = [match];
    // @ts-expect-error
    if (opts?.formMethod === "post") {
      if (currentRouter.state.navigation?.location) {
        let matches = matchRoutes(
          enhancedRoutes,
          currentRouter.state.navigation.location
        );
        invariant(matches, "No matches found for fetcher");
        activeLoaderMatches = matches;
      } else {
        activeLoaderMatches = currentRouter.state.matches;
      }
    }

    // Generate helpers for all route matches that contain loaders
    let loaderHelpers = getHelpers(
      activeLoaderMatches.filter((m) => m.route.loader),
      navigationId,
      (routeId, helpers) =>
        activeHelpers.set(`fetch:${navigationId}:loader:${routeId}`, helpers)
    );
    let actionHelpers = getHelpers(
      match.route.action ? [match] : [],
      navigationId,
      (routeId, helpers) =>
        activeHelpers.set(`fetch:${navigationId}:action:${routeId}`, helpers)
    );

    return {
      key,
      navigationId,
      get fetcher() {
        invariant(currentRouter, "No currentRouter available");
        return currentRouter.getFetcher(key);
      },
      loaders: loaderHelpers,
      actions: actionHelpers,
    };
  }

  // Simulate a navigation, returning a series of helpers to manually
  // control/assert loader/actions
  function navigate(n: number): Promise<NavigationHelpers>;
  function navigate(
    href: string,
    opts?: RouterNavigateOptions
  ): Promise<NavigationHelpers>;
  async function navigate(
    href: number | string,
    opts?: RouterNavigateOptions
  ): Promise<NavigationHelpers> {
    let navigationId = ++guid;
    let helpers: NavigationHelpers;

    invariant(currentRouter, "No currentRouter available");

    // @ts-expect-error
    if (opts?.formMethod === "post") {
      activeActionType = "navigation";
      activeActionNavigationId = navigationId;
      // Assume happy path and mark this navigations loaders as active.  Even if
      // we never call them from the router (if the action rejects) we'll want
      // this to be accurate so we can assert against the stubs
      activeLoaderType = "navigation";
      activeLoaderNavigationId = navigationId;
    } else {
      activeLoaderType = "navigation";
      activeLoaderNavigationId = navigationId;
    }

    if (typeof href === "number") {
      let promise = new Promise<void>((r) => {
        invariant(currentRouter, "No currentRouter available");
        let unsubscribe = currentRouter.subscribe(() => {
          helpers = getNavigationHelpers(
            history.createHref(history.location),
            navigationId
          );
          unsubscribe();
          r();
        });
      });
      currentRouter.navigate(href);
      await promise;
      //@ts-ignore
      return helpers;
    }

    helpers = getNavigationHelpers(href, navigationId);
    currentRouter.navigate(href, opts);
    return helpers;
  }

  // Simulate a fetcher call, returning a series of helpers to manually
  // control/assert loader/actions
  async function fetch(
    href: string,
    opts?: RouterFetchOptions
  ): Promise<FetcherHelpers>;
  async function fetch(
    href: string,
    key: string,
    opts?: RouterFetchOptions
  ): Promise<FetcherHelpers>;
  async function fetch(
    href: string,
    key: string,
    routeId: string,
    opts?: RouterFetchOptions
  ): Promise<FetcherHelpers>;
  async function fetch(
    href: string,
    keyOrOpts?: string | RouterFetchOptions,
    routeIdOrOpts?: string | RouterFetchOptions,
    opts?: RouterFetchOptions
  ): Promise<FetcherHelpers> {
    let navigationId = ++guid;
    let key = typeof keyOrOpts === "string" ? keyOrOpts : String(navigationId);
    let routeId =
      typeof routeIdOrOpts === "string"
        ? routeIdOrOpts
        : String(enhancedRoutes[0].id);
    opts =
      typeof keyOrOpts === "object"
        ? keyOrOpts
        : typeof routeIdOrOpts === "object"
        ? routeIdOrOpts
        : opts;
    invariant(currentRouter, "No currentRouter available");

    // @ts-expect-error
    if (opts?.formMethod === "post") {
      activeActionType = "fetch";
      activeActionFetchId = navigationId;
    } else {
      activeLoaderType = "fetch";
      activeLoaderFetchId = navigationId;
    }

    let helpers = getFetcherHelpers(key, href, navigationId, opts);
    currentRouter.fetch(key, routeId, href, opts);
    return helpers;
  }

  // Simulate a revalidation, returning a series of helpers to manually
  // control/assert loader/actions
  async function revalidate(
    type: "navigation" | "fetch" = "navigation",
    shimRouteId?: string
  ): Promise<NavigationHelpers> {
    invariant(currentRouter, "No currentRouter available");
    let navigationId;
    if (type === "fetch") {
      // This is a special case for when we want to test revalidation against
      // fetchers, so that our A.loaders.routeId will trigger the fetcher loader,
      // not the route loader
      navigationId = ++guid;
      activeLoaderType = "fetch";
      activeLoaderFetchId = navigationId;
    } else {
      // if a revalidation interrupts an action submission, we don't actually
      // start a new new navigation so don't increment here
      navigationId =
        currentRouter.state.navigation.state === "submitting" &&
        currentRouter.state.navigation.formMethod !== "get"
          ? guid
          : ++guid;
      activeLoaderType = "navigation";
      activeLoaderNavigationId = navigationId;
    }
    let href = currentRouter.createHref(
      currentRouter.state.navigation.location || currentRouter.state.location
    );
    let helpers = getNavigationHelpers(href, navigationId);
    if (shimRouteId) {
      shimHelper(helpers.loaders, type, "loader", shimRouteId);
    }
    currentRouter.revalidate();
    return helpers;
  }

  function shimHelper(
    navHelpers: Record<string, Helpers>,
    type: "navigation" | "fetch",
    type2: "loader" | "action",
    routeId: string
  ) {
    invariant(!navHelpers[routeId], "Can't overwrite existing helpers");
    navHelpers[routeId] = getRouteHelpers(routeId, guid, (routeId, helpers) =>
      activeHelpers.set(`${type}:${guid}:${type2}:${routeId}`, helpers)
    );
  }

  return {
    history,
    router: currentRouter,
    navigate,
    fetch,
    revalidate,
    shimHelper,
  };
}

function initializeTmTest(init?: {
  url?: string;
  hydrationData?: HydrationState;
}) {
  return setup({
    routes: TM_ROUTES,
    hydrationData: init?.hydrationData || {
      loaderData: { root: "ROOT", index: "INDEX" },
    },
    ...(init?.url ? { initialEntries: [init.url] } : {}),
  });
}
//#endregion

///////////////////////////////////////////////////////////////////////////////
//#region Tests
///////////////////////////////////////////////////////////////////////////////

// Reusable routes for a simple tasks app, for test cases that don't want
// to create their own more complex routes
const TASK_ROUTES: TestRouteObject[] = [
  {
    id: "root",
    path: "/",
    loader: true,
    hasErrorBoundary: true,
    children: [
      {
        id: "index",
        index: true,
        loader: true,
      },
      {
        id: "tasks",
        path: "tasks",
        loader: true,
        action: true,
        hasErrorBoundary: true,
      },
      {
        id: "tasksId",
        path: "tasks/:id",
        loader: true,
        action: true,
        hasErrorBoundary: true,
      },
      {
        id: "noLoader",
        path: "no-loader",
      },
    ],
  },
];

const TM_ROUTES = [
  {
    path: "",
    id: "root",

    module: "",
    hasErrorBoundary: true,
    loader: true,
    children: [
      {
        path: "/",
        id: "index",
        hasLoader: true,
        loader: true,
        action: true,

        module: "",
      },
      {
        path: "/foo",
        id: "foo",
        loader: true,
        action: true,

        module: "",
      },
      {
        path: "/foo/bar",
        id: "foobar",
        loader: true,
        action: true,

        module: "",
      },
      {
        path: "/bar",
        id: "bar",
        loader: true,
        action: true,

        module: "",
      },
      {
        path: "/baz",
        id: "baz",
        loader: true,
        action: true,

        module: "",
      },
      {
        path: "/p/:param",
        id: "param",
        loader: true,
        action: true,

        module: "",
      },
    ],
  },
];

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

// Detect any failures inside the router navigate code
afterEach(() => {
  // Cleanup any routers created using setup()
  if (currentRouter) {
    // eslint-disable-next-line jest/no-standalone-expect
    expect(currentRouter._internalFetchControllers.size).toBe(0);
    // eslint-disable-next-line jest/no-standalone-expect
    expect(currentRouter._internalActiveDeferreds.size).toBe(0);
  }
  currentRouter?.dispose();
  currentRouter = null;

  // Reject any lingering deferreds and remove
  for (let dfd of gcDfds.values()) {
    dfd.reject();
    gcDfds.delete(dfd);
  }

  // @ts-ignore
  console.warn.mockReset();
});

describe("a router", () => {
  describe("init", () => {
    it("with initial values", async () => {
      let history = createMemoryHistory({ initialEntries: ["/"] });
      let router = createRouter({
        routes: [
          {
            id: "root",
            path: "/",
            hasErrorBoundary: true,
            loader: () => Promise.resolve(),
          },
        ],
        history,
        hydrationData: {
          loaderData: { root: "LOADER DATA" },
          actionData: { root: "ACTION DATA" },
          errors: { root: new Error("lol") },
        },
      });
      expect(router.state).toEqual({
        historyAction: "POP",
        loaderData: {
          root: "LOADER DATA",
        },
        actionData: {
          root: "ACTION DATA",
        },
        errors: {
          root: new Error("lol"),
        },
        location: {
          hash: "",
          key: expect.any(String),
          pathname: "/",
          search: "",
          state: null,
        },
        matches: [
          {
            params: {},
            pathname: "/",
            pathnameBase: "/",
            route: {
              hasErrorBoundary: true,
              id: "root",
              loader: expect.any(Function),
              path: "/",
            },
          },
        ],
        initialized: true,
        navigation: {
          location: undefined,
          state: "idle",
        },
        preventScrollReset: false,
        restoreScrollPosition: null,
        revalidation: "idle",
        fetchers: new Map(),
      });
    });

    it("requires routes", async () => {
      let history = createMemoryHistory({ initialEntries: ["/"] });
      expect(() =>
        createRouter({
          routes: [],
          history,
          hydrationData: {},
        })
      ).toThrowErrorMatchingInlineSnapshot(
        `"You must provide a non-empty routes array to createRouter"`
      );
    });

    it("converts routes to data routes", async () => {
      let history = createMemoryHistory({
        initialEntries: ["/child/grandchild"],
      });
      let routes = [
        {
          path: "/",
          children: [
            {
              id: "child-keep-me",
              path: "child",
              children: [
                {
                  path: "grandchild",
                },
              ],
            },
          ],
        },
      ];
      let originalRoutes = JSON.parse(JSON.stringify(routes));
      let router = createRouter({
        routes,
        history,
        hydrationData: {},
      });
      // routes are not mutated in place
      expect(routes).toEqual(originalRoutes);
      expect(router.state.matches).toMatchObject([
        {
          route: {
            id: "0",
          },
        },
        {
          route: {
            id: "child-keep-me",
          },
        },
        {
          route: {
            id: "0-0-0",
          },
        },
      ]);
    });

    it("throws if it finds duplicate route ids", async () => {
      let history = createMemoryHistory({
        initialEntries: ["/child/grandchild"],
      });
      let routes = [
        {
          path: "/",
          children: [
            {
              id: "child",
              path: "child",
              children: [
                {
                  id: "child",
                  path: "grandchild",
                },
              ],
            },
          ],
        },
      ];
      expect(() =>
        createRouter({
          routes,
          history,
          hydrationData: {},
        })
      ).toThrowErrorMatchingInlineSnapshot(
        `"Found a route id collision on id \\"child\\".  Route id's must be globally unique within Data Router usages"`
      );
    });

    it("supports a basename prop for route matching", async () => {
      let history = createMemoryHistory({
        initialEntries: ["/base/name/path"],
      });
      let router = createRouter({
        basename: "/base/name",
        routes: [{ path: "path" }],
        history,
      });
      expect(router.state).toMatchObject({
        location: {
          hash: "",
          key: expect.any(String),
          pathname: "/base/name/path",
          search: "",
          state: null,
        },
        matches: [
          {
            params: {},
            pathname: "/path",
            pathnameBase: "/path",
            route: {
              id: "0",
              path: "path",
            },
          },
        ],
        initialized: true,
      });
    });

    it("supports subscribers", async () => {
      let history = createMemoryHistory({ initialEntries: ["/"] });
      let count = 0;
      let router = createRouter({
        routes: [
          {
            id: "root",
            path: "/",
            hasErrorBoundary: true,
            loader: () => ++count,
          },
        ],
        history,
        hydrationData: {
          loaderData: { root: 0 },
        },
      }).initialize();
      expect(router.state.loaderData).toEqual({
        root: 0,
      });

      let subscriber = jest.fn();
      let unsubscribe = router.subscribe(subscriber);
      let subscriber2 = jest.fn();
      let unsubscribe2 = router.subscribe(subscriber2);

      await router.navigate("/?key=a");
      expect(subscriber.mock.calls[0][0].navigation.state).toBe("loading");
      expect(subscriber.mock.calls[0][0].navigation.location.search).toBe(
        "?key=a"
      );
      expect(subscriber.mock.calls[1][0].navigation.state).toBe("idle");
      expect(subscriber.mock.calls[1][0].location.search).toBe("?key=a");
      expect(subscriber2.mock.calls[0][0].navigation.state).toBe("loading");
      expect(subscriber2.mock.calls[0][0].navigation.location.search).toBe(
        "?key=a"
      );
      expect(subscriber2.mock.calls[1][0].navigation.state).toBe("idle");
      expect(subscriber2.mock.calls[1][0].location.search).toBe("?key=a");

      unsubscribe2();
      await router.navigate("/?key=b");
      expect(subscriber.mock.calls[2][0].navigation.state).toBe("loading");
      expect(subscriber.mock.calls[2][0].navigation.location.search).toBe(
        "?key=b"
      );
      expect(subscriber.mock.calls[3][0].navigation.state).toBe("idle");
      expect(subscriber.mock.calls[3][0].location.search).toBe("?key=b");

      unsubscribe();
      await router.navigate("/?key=c");
      expect(subscriber).toHaveBeenCalledTimes(4);
      expect(subscriber2).toHaveBeenCalledTimes(2);
    });
  });

  describe("normal navigation", () => {
    it("fetches data on navigation", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve("FOO");
      expect(t.router.state.loaderData).toMatchInlineSnapshot(`
        Object {
          "foo": "FOO",
          "root": "ROOT",
        }
      `);
    });

    it("allows `null` as a valid data value", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve(null);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        foo: null,
      });
    });

    it("unwraps non-redirect json Responses", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve(
        new Response(JSON.stringify({ key: "value" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        })
      );
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        foo: { key: "value" },
      });
    });

    it("unwraps non-redirect json Responses (json helper)", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve(json({ key: "value" }, 200));
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        foo: { key: "value" },
      });
    });

    it("unwraps non-redirect text Responses", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve(new Response("FOO", { status: 200 }));
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        foo: "FOO",
      });
    });

    it("does not fetch unchanging layout data", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve("FOO");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData.root).toBe("ROOT");
    });

    it("reloads all routes on search changes", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo?q=1");
      await A.loaders.root.resolve("ROOT1");
      await A.loaders.foo.resolve("1");
      expect(A.loaders.root.stub.mock.calls.length).toBe(1);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT1",
        foo: "1",
      });

      let B = await t.navigate("/foo?q=2");
      await B.loaders.root.resolve("ROOT2");
      await B.loaders.foo.resolve("2");
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT2",
        foo: "2",
      });
    });

    it("does not reload all routes when search does not change", async () => {
      let t = initializeTmTest();
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      let A = await t.navigate("/foo?q=1");
      await A.loaders.root.resolve("ROOT1");
      await A.loaders.foo.resolve("1");
      expect(A.loaders.root.stub.mock.calls.length).toBe(1);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT1",
        foo: "1",
      });

      let B = await t.navigate("/foo/bar?q=1");
      await B.loaders.foobar.resolve("2");
      expect(B.loaders.root.stub.mock.calls.length).toBe(0);

      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT1",
        foobar: "2",
      });
    });

    it("reloads only routes with changed params", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/p/one");
      await A.loaders.param.resolve("one");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        param: "one",
      });

      let B = await t.navigate("/p/two");
      await B.loaders.param.resolve("two");
      expect(B.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        param: "two",
      });
    });

    it("reloads all routes on refresh", async () => {
      let t = initializeTmTest();
      let url = "/p/same";

      let A = await t.navigate(url);
      await A.loaders.param.resolve("1");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        param: "1",
      });

      let B = await t.navigate(url);
      await B.loaders.root.resolve("ROOT2");
      await B.loaders.param.resolve("2");
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT2",
        param: "2",
      });
    });

    it("does not load anything on hash change only", async () => {
      let t = initializeTmTest();
      expect(t.router.state.loaderData).toMatchObject({ root: "ROOT" });
      let A = await t.navigate("/#bar");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toMatchObject({ root: "ROOT" });
    });

    it("sets all right states on hash change only", async () => {
      let t = initializeTmTest();
      let key = t.router.state.location.key;
      t.navigate("/#bar");
      // hash changes are synchronous but force a key change
      expect(t.router.state.location.key).not.toBe(key);
      expect(t.router.state.location.hash).toBe("#bar");
      expect(t.router.state.navigation.state).toBe("idle");
    });

    it("loads new data on new routes even if there's also a hash change", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo#bar");
      expect(t.router.state.navigation.state).toBe("loading");
      await A.loaders.foo.resolve("A");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        foo: "A",
      });
    });

    it("redirects from loaders (throw)", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/bar");
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.navigation.location?.pathname).toBe("/bar");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      let B = await A.loaders.bar.redirect("/baz");
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.navigation.location?.pathname).toBe("/baz");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      await B.loaders.baz.resolve("B");
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.location.pathname).toBe("/baz");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        baz: "B",
      });
    });

    it("redirects from loaders (return)", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/bar");
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.navigation.location?.pathname).toBe("/bar");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      let B = await A.loaders.bar.redirectReturn("/baz");
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.navigation.location?.pathname).toBe("/baz");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      await B.loaders.baz.resolve("B");
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.location.pathname).toBe("/baz");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
        baz: "B",
      });
    });

    it("reloads all routes if X-Remix-Revalidate was set in a loader redirect header", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo");
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.navigation.location?.pathname).toBe("/foo");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      let B = await A.loaders.foo.redirectReturn("/bar", undefined, {
        "X-Remix-Revalidate": "yes",
      });
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.navigation.location?.pathname).toBe("/bar");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT",
      });

      await B.loaders.root.resolve("ROOT*");
      await B.loaders.bar.resolve("BAR");
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.location.pathname).toBe("/bar");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT*",
        bar: "BAR",
      });
    });

    it("reloads all routes if X-Remix-Revalidate was set in a loader redirect header (chained redirects)", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0); // Reused on navigation

      let B = await A.loaders.foo.redirectReturn("/bar", undefined, {
        "X-Remix-Revalidate": "yes",
      });
      await B.loaders.root.resolve("ROOT*");
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);

      // No cookie on second redirect
      let C = await B.loaders.bar.redirectReturn("/baz");
      expect(C.loaders.root.stub.mock.calls.length).toBe(1);
      await C.loaders.root.resolve("ROOT**");
      await C.loaders.baz.resolve("BAZ");

      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.location.pathname).toBe("/baz");
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT**",
        baz: "BAZ",
      });
    });
  });

  describe("shouldRevalidate", () => {
    it("provides a default implementation", async () => {
      let rootLoader = jest.fn((args) => "ROOT");

      let history = createMemoryHistory();
      let router = createRouter({
        history,
        routes: [
          {
            path: "",
            loader: async (...args) => rootLoader(...args),
            children: [
              {
                path: "/",
                id: "index",
              },
              {
                path: "/child",
                action: async () => null,
              },
              {
                path: "/redirect",
                action: async () =>
                  new Response(null, {
                    status: 301,
                    headers: { location: "/" },
                  }),
              },
              {
                path: "/cookie",
                loader: async () =>
                  new Response(null, {
                    status: 301,
                    headers: {
                      location: "/",
                      "X-Remix-Revalidate": "1",
                    },
                  }),
              },
            ],
          },
        ],
      });
      router.initialize();

      // Initial load - no existing data, should always call loader
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      rootLoader.mockClear();

      // Should not re-run on normal navigations re-using the loader
      router.navigate("/child");
      await tick();
      router.navigate("/");
      await tick();
      router.navigate("/child");
      await tick();
      expect(rootLoader.mock.calls.length).toBe(0);
      rootLoader.mockClear();

      // Should call on same-path navigations
      router.navigate("/child");
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      rootLoader.mockClear();

      // Should call on query string changes
      router.navigate("/child?key=value");
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      rootLoader.mockClear();

      // Should call after form submission revalidation
      router.navigate("/child", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      rootLoader.mockClear();

      // Should call after form submission redirect
      router.navigate("/redirect", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      rootLoader.mockClear();

      // Should call after loader redirect with X-Remix-Revalidate
      router.navigate("/cookie");
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      rootLoader.mockClear();

      router.dispose();
    });

    it("delegates to the route if it should reload or not", async () => {
      let rootLoader = jest.fn((args) => "ROOT");
      let childLoader = jest.fn((args) => "CHILD");
      let paramsLoader = jest.fn((args) => "PARAMS");
      let shouldRevalidate = jest.fn((args) => false);

      let history = createMemoryHistory();
      let router = createRouter({
        history,
        routes: [
          {
            path: "",
            id: "root",
            loader: async (...args) => rootLoader(...args),
            shouldRevalidate: (args) => shouldRevalidate(args) === true,

            children: [
              {
                path: "/",
                id: "index",
              },
              {
                path: "/child",
                id: "child",
                loader: async (...args) => childLoader(...args),
                action: async () => ({ ok: false }),
              },
              {
                path: "/params/:a/:b",
                id: "params",
                loader: async (...args) => paramsLoader(...args),
              },
            ],
          },
        ],
      });
      router.initialize();

      // Initial load - no existing data, should always call loader and should
      // not give use ability to opt-out
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      expect(shouldRevalidate.mock.calls.length).toBe(0);
      rootLoader.mockClear();
      shouldRevalidate.mockClear();

      // Should not re-run on normal navigations re-using the loader
      router.navigate("/child");
      await tick();
      router.navigate("/");
      await tick();
      router.navigate("/child");
      await tick();
      expect(rootLoader.mock.calls.length).toBe(0);
      expect(shouldRevalidate.mock.calls.length).toBe(3);
      rootLoader.mockClear();
      shouldRevalidate.mockClear();

      // Check that we pass the right args to shouldRevalidate and respect it's answer
      shouldRevalidate.mockImplementation(() => true);
      router.navigate("/params/aValue/bValue");
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      expect(shouldRevalidate.mock.calls[0][0]).toMatchObject({
        currentParams: {},
        currentUrl: new URL("http://localhost/child"),
        nextParams: {
          a: "aValue",
          b: "bValue",
        },
        nextUrl: new URL("http://localhost/params/aValue/bValue"),
        defaultShouldRevalidate: false,
        actionResult: null,
      });
      rootLoader.mockClear();
      shouldRevalidate.mockClear();

      // On actions we send along the action result
      shouldRevalidate.mockImplementation(
        ({ actionResult }) => actionResult.ok === true
      );
      router.navigate("/child", {
        formMethod: "post",
        formData: createFormData({}),
      });
      await tick();
      expect(rootLoader.mock.calls.length).toBe(0);

      router.dispose();
    });

    it("provides the default implementation to the route function", async () => {
      let rootLoader = jest.fn((args) => "ROOT");

      let history = createMemoryHistory();
      let router = createRouter({
        history,
        routes: [
          {
            path: "",
            loader: async (...args) => rootLoader(...args),
            shouldRevalidate: ({ defaultShouldRevalidate }) =>
              defaultShouldRevalidate,
            children: [
              {
                path: "/",
                id: "index",
              },
              {
                path: "/child",
                action: async () => null,
              },
              {
                path: "/redirect",
                action: async () =>
                  new Response(null, {
                    status: 301,
                    headers: { location: "/" },
                  }),
              },
              {
                path: "/cookie",
                loader: async () =>
                  new Response(null, {
                    status: 301,
                    headers: {
                      location: "/",
                      "X-Remix-Revalidate": "1",
                    },
                  }),
              },
            ],
          },
        ],
      });
      router.initialize();

      // Initial load - no existing data, should always call loader
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      rootLoader.mockClear();

      // Should not re-run on normal navigations re-using the loader
      router.navigate("/child");
      await tick();
      router.navigate("/");
      await tick();
      router.navigate("/child");
      await tick();
      expect(rootLoader.mock.calls.length).toBe(0);
      rootLoader.mockClear();

      // Should call on same-path navigations
      router.navigate("/child");
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      rootLoader.mockClear();

      // Should call on query string changes
      router.navigate("/child?key=value");
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      rootLoader.mockClear();

      // Should call after form submission revalidation
      router.navigate("/child", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      rootLoader.mockClear();

      // Should call after form submission redirect
      router.navigate("/redirect", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      rootLoader.mockClear();

      // Should call after loader redirect with X-Remix-Revalidate
      router.navigate("/cookie");
      await tick();
      expect(rootLoader.mock.calls.length).toBe(1);
      rootLoader.mockClear();

      router.dispose();
    });

    it("applies to fetcher loads", async () => {
      let count = 0;
      let fetchLoader = jest.fn((args) => `FETCH ${++count}`);
      let shouldRevalidate = jest.fn((args) => false);

      let history = createMemoryHistory();
      let router = createRouter({
        history,
        routes: [
          {
            path: "",
            id: "root",

            children: [
              {
                path: "/",
                id: "index",
              },
              {
                path: "/child",
                id: "child",
              },
              {
                path: "/fetch",
                id: "fetch",
                loader: async (...args) => fetchLoader(...args),
                shouldRevalidate: (args) => shouldRevalidate(args) === true,
              },
            ],
          },
        ],
      });
      router.initialize();
      await tick();

      let key = "key";
      router.fetch(key, "root", "/fetch");
      await tick();
      expect(router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: "FETCH 1",
      });
      expect(shouldRevalidate.mock.calls.length).toBe(0);

      // Normal navigations should not trigger fetcher revalidations
      router.navigate("/child");
      await tick();
      router.navigate("/");
      await tick();
      expect(shouldRevalidate.mock.calls.length).toBe(0);
      expect(router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: "FETCH 1",
      });
      expect(shouldRevalidate.mock.calls.length).toBe(0);

      // Post navigation should trigger shouldRevalidate, and loader should not re-run
      router.navigate("/child", {
        formMethod: "post",
        formData: createFormData({}),
      });
      await tick();
      expect(router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: "FETCH 1",
      });
      expect(shouldRevalidate.mock.calls.length).toBe(1);
      expect(shouldRevalidate.mock.calls[0][0]).toMatchObject({
        currentParams: {},
        currentUrl: new URL("http://localhost/fetch"),
        nextParams: {},
        nextUrl: new URL("http://localhost/fetch"),
        formAction: "/child",
        formData: createFormData({}),
        formEncType: "application/x-www-form-urlencoded",
        formMethod: "post",
        defaultShouldRevalidate: true,
      });

      router.dispose();
    });

    it("applies to fetcher submissions and sends fetcher actionResult through", async () => {
      let shouldRevalidate = jest.fn((args) => true);

      let history = createMemoryHistory();
      let router = createRouter({
        history,
        routes: [
          {
            path: "",
            id: "root",

            children: [
              {
                path: "/",
                id: "index",
                loader: () => "INDEX",
                shouldRevalidate,
              },
              {
                path: "/fetch",
                id: "fetch",
                action: () => "FETCH",
              },
            ],
          },
        ],
      });
      router.initialize();
      await tick();

      let key = "key";
      router.fetch(key, "root", "/fetch", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      await tick();
      expect(router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: "FETCH",
      });

      expect(shouldRevalidate.mock.calls[0][0]).toMatchInlineSnapshot(`
        Object {
          "actionResult": "FETCH",
          "currentParams": Object {},
          "currentUrl": "http://localhost/",
          "defaultShouldRevalidate": true,
          "formAction": "/fetch",
          "formData": FormData {},
          "formEncType": "application/x-www-form-urlencoded",
          "formMethod": "post",
          "nextParams": Object {},
          "nextUrl": "http://localhost/",
        }
      `);

      router.dispose();
    });

    it("preserves non-revalidated loaderData on navigations", async () => {
      let count = 0;
      let history = createMemoryHistory();
      let router = createRouter({
        history,
        routes: [
          {
            path: "",
            id: "root",
            loader: () => `ROOT ${++count}`,

            children: [
              {
                path: "/",
                id: "index",
                loader: (args) => "SHOULD NOT GET CALLED",
                shouldRevalidate: () => false,
              },
            ],
          },
        ],
        hydrationData: {
          loaderData: {
            root: "ROOT 0",
            index: "INDEX",
          },
        },
      });
      router.initialize();
      await tick();

      // Navigating to the same link would normally cause all loaders to re-run
      router.navigate("/");
      await tick();
      expect(router.state.loaderData).toEqual({
        root: "ROOT 1",
        index: "INDEX",
      });

      router.navigate("/");
      await tick();
      expect(router.state.loaderData).toEqual({
        root: "ROOT 2",
        index: "INDEX",
      });

      router.dispose();
    });

    it("preserves non-revalidated loaderData on fetches", async () => {
      let count = 0;
      let history = createMemoryHistory();
      let router = createRouter({
        history,
        routes: [
          {
            path: "",
            id: "root",

            children: [
              {
                path: "/",
                id: "index",
                loader: () => "SHOULD NOT GET CALLED",
                shouldRevalidate: () => false,
              },
              {
                path: "/fetch",
                id: "fetch",
                action: () => `FETCH ${++count}`,
              },
            ],
          },
        ],
        hydrationData: {
          loaderData: {
            index: "INDEX",
          },
        },
      });
      router.initialize();
      await tick();

      let key = "key";

      router.fetch(key, "root", "/fetch", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      await tick();
      expect(router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: "FETCH 1",
      });
      expect(router.state.loaderData).toMatchObject({
        index: "INDEX",
      });

      router.fetch(key, "root", "/fetch", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      await tick();
      expect(router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: "FETCH 2",
      });
      expect(router.state.loaderData).toMatchObject({
        index: "INDEX",
      });

      router.dispose();
    });

    it("requires an explicit false return value to override default true behavior", async () => {
      let count = 0;
      let returnValue = true;
      let history = createMemoryHistory();
      let router = createRouter({
        history,
        routes: [
          {
            path: "",
            id: "root",
            loader: () => ++count,
            shouldRevalidate: () => returnValue,
          },
        ],
        hydrationData: {
          loaderData: {
            root: 0,
          },
        },
      });
      router.initialize();

      await tick();
      expect(router.state.loaderData).toEqual({
        root: 0,
      });

      router.revalidate();
      await tick();
      expect(router.state.loaderData).toEqual({
        root: 1,
      });

      // @ts-expect-error
      returnValue = undefined;
      router.revalidate();
      await tick();
      expect(router.state.loaderData).toEqual({
        root: 2,
      });

      // @ts-expect-error
      returnValue = null;
      router.revalidate();
      await tick();
      expect(router.state.loaderData).toEqual({
        root: 3,
      });

      // @ts-expect-error
      returnValue = "";
      router.revalidate();
      await tick();
      expect(router.state.loaderData).toEqual({
        root: 4,
      });

      returnValue = false;
      router.revalidate();
      await tick();
      expect(router.state.loaderData).toEqual({
        root: 4, // No revalidation
      });

      router.dispose();
    });

    it("requires an explicit true return value to override default false behavior", async () => {
      let count = 0;
      let returnValue = false;
      let history = createMemoryHistory({ initialEntries: ["/a"] });
      let router = createRouter({
        history,
        routes: [
          {
            path: "/",
            id: "root",
            loader: () => ++count,
            shouldRevalidate: () => returnValue,

            children: [
              {
                path: "a",
                id: "a",
              },
              {
                path: "b",
                id: "b",
              },
            ],
          },
        ],
        hydrationData: {
          loaderData: {
            root: 0,
          },
        },
      });
      router.initialize();

      await tick();
      expect(router.state.loaderData).toEqual({
        root: 0,
      });

      router.navigate("/b");
      await tick();
      expect(router.state.loaderData).toEqual({
        root: 0,
      });

      // @ts-expect-error
      returnValue = undefined;
      router.navigate("/a");
      await tick();
      expect(router.state.loaderData).toEqual({
        root: 0,
      });

      // @ts-expect-error
      returnValue = null;
      router.navigate("/b");
      await tick();
      expect(router.state.loaderData).toEqual({
        root: 0,
      });

      // @ts-expect-error
      returnValue = "truthy";
      router.navigate("/a");
      await tick();
      expect(router.state.loaderData).toEqual({
        root: 0,
      });

      returnValue = true;
      router.navigate("/b");
      await tick();
      expect(router.state.loaderData).toEqual({
        root: 1,
      });

      router.dispose();
    });
  });

  describe("no route match", () => {
    it("navigations to root catch", () => {
      let t = initializeTmTest();
      t.navigate("/not-found");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT",
      });
      expect(t.router.state.errors).toEqual({
        root: {
          status: 404,
          statusText: "Not Found",
          data: null,
        },
      });
      expect(t.router.state.matches).toMatchObject([
        {
          params: {},
          pathname: "",
          route: {
            hasErrorBoundary: true,
            children: expect.any(Array),

            id: "root",
            loader: expect.any(Function),
            module: "",
            path: "",
          },
        },
      ]);
    });

    it("clears prior loader/action data", async () => {
      let t = initializeTmTest();
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT",
        index: "INDEX",
      });

      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      await A.actions.foo.resolve("ACTION");
      await A.loaders.root.resolve("ROOT*");
      await A.loaders.foo.resolve("LOADER");
      expect(t.router.state.actionData).toEqual({
        foo: "ACTION",
      });
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT*",
        foo: "LOADER",
      });

      t.navigate("/not-found");
      expect(t.router.state.actionData).toBe(null);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT*",
      });
      expect(t.router.state.errors).toEqual({
        root: {
          status: 404,
          statusText: "Not Found",
          data: null,
        },
      });
      expect(t.router.state.matches).toMatchObject([
        {
          params: {},
          pathname: "",
          route: {
            hasErrorBoundary: true,
            children: expect.any(Array),

            id: "root",
            loader: expect.any(Function),
            module: "",
            path: "",
          },
        },
      ]);
    });
  });

  describe("errors on navigation", () => {
    describe("with an error boundary in the throwing route", () => {
      it("uses the throwing route's error boundary", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              children: [
                {
                  path: "/child",
                  id: "child",
                  hasErrorBoundary: true,
                  loader: true,
                },
              ],
            },
          ],
        });
        let nav = await t.navigate("/child");
        await nav.loaders.child.reject(new Error("Kaboom!"));
        expect(t.router.state.errors).toEqual({
          child: new Error("Kaboom!"),
        });
      });
    });

    describe("with an error boundary above the throwing route", () => {
      it("uses the nearest error boundary", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              hasErrorBoundary: true,
              children: [
                {
                  path: "/child",
                  id: "child",
                  loader: true,
                },
              ],
            },
          ],
          hydrationData: { loaderData: { parent: "stuff" } },
        });
        let nav = await t.navigate("/child");
        await nav.loaders.child.reject(new Error("Kaboom!"));
        expect(t.router.state.errors).toEqual({
          parent: new Error("Kaboom!"),
        });
      });

      it("clears out the error on new locations", async () => {
        let t = setup({
          routes: [
            {
              path: "",
              id: "root",
              loader: true,
              children: [
                {
                  path: "/",
                  id: "parent",
                  children: [
                    {
                      path: "/child",
                      id: "child",
                      hasErrorBoundary: true,
                      loader: true,
                    },
                  ],
                },
              ],
            },
          ],
          hydrationData: { loaderData: { root: "ROOT" } },
        });

        let nav = await t.navigate("/child");
        await nav.loaders.child.reject("Kaboom!");
        expect(t.router.state.loaderData).toEqual({ root: "ROOT" });
        expect(t.router.state.errors).toEqual({ child: "Kaboom!" });

        await t.navigate("/");
        expect(t.router.state.loaderData).toEqual({ root: "ROOT" });
        expect(t.router.state.errors).toBe(null);
      });
    });

    it("loads data above error boundary route", async () => {
      let t = setup({
        routes: [
          {
            path: "/",
            id: "a",
            loader: true,
            children: [
              {
                path: "/b",
                id: "b",
                loader: true,
                hasErrorBoundary: true,
                children: [
                  {
                    path: "/b/c",
                    id: "c",
                    loader: true,
                  },
                ],
              },
            ],
          },
        ],
        hydrationData: { loaderData: { a: "LOADER A" } },
      });
      let nav = await t.navigate("/b/c");
      await nav.loaders.b.resolve("LOADER B");
      await nav.loaders.c.reject("Kaboom!");
      expect(t.router.state.loaderData).toEqual({
        a: "LOADER A",
        b: "LOADER B",
      });
      expect(t.router.state.errors).toEqual({
        b: "Kaboom!",
      });
    });
  });

  describe("POP navigations", () => {
    it("does a normal load when backing into an action redirect", async () => {
      // start at / (history stack: [/])
      let t = initializeTmTest();

      // POST /foo, redirect /bar (history stack: [/, /bar])
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      let B = await A.actions.foo.redirect("/bar");
      await B.loaders.root.resolve("ROOT DATA");
      await B.loaders.bar.resolve("B LOADER");
      expect(t.router.state.historyAction).toEqual("PUSH");
      expect(t.router.state.location.pathname).toEqual("/bar");
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT DATA",
        bar: "B LOADER",
      });

      // Link to /baz (history stack: [/, /bar, /baz])
      let C = await t.navigate("/baz");
      await C.loaders.baz.resolve("C LOADER");
      expect(t.router.state.historyAction).toEqual("PUSH");
      expect(t.router.state.location.pathname).toEqual("/baz");
      expect(C.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT DATA",
        baz: "C LOADER",
      });

      // POP /bar (history stack: [/, /bar])
      let D = await t.navigate(-1);
      await D.loaders.bar.resolve("D LOADER");
      expect(t.router.state.historyAction).toEqual("POP");
      expect(t.router.state.location.pathname).toEqual("/bar");
      expect(D.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT DATA",
        bar: "D LOADER",
      });

      // POP / (history stack: [/])
      let E = await t.navigate(-1);
      await E.loaders.index.resolve("E LOADER");
      expect(t.router.state.historyAction).toEqual("POP");
      expect(t.router.state.location.pathname).toEqual("/");
      expect(E.loaders.root.stub.mock.calls.length).toBe(0);
      expect(t.router.state.loaderData).toMatchObject({
        root: "ROOT DATA",
        index: "E LOADER",
      });
    });

    it("navigates correctly using POP navigations", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve("FOO");
      expect(t.router.state.location.pathname).toEqual("/foo");

      let B = await t.navigate("/bar");
      await B.loaders.bar.resolve("BAR");
      expect(t.router.state.location.pathname).toEqual("/bar");

      let C = await t.navigate(-1);
      await C.loaders.foo.resolve("FOO*");
      expect(t.router.state.location.pathname).toEqual("/foo");

      let D = await t.navigate("/baz", { replace: true });
      await D.loaders.baz.resolve("BAZ");
      expect(t.router.state.location.pathname).toEqual("/baz");

      // POP to /
      let E = await t.navigate(-1);
      await E.loaders.index.resolve("INDEX*");
      expect(t.router.state.location.pathname).toEqual("/");
    });

    it("navigates correctly using POP navigations across actions", async () => {
      let t = initializeTmTest();

      // Navigate to /foo
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve("FOO");
      expect(t.router.state.location.pathname).toEqual("/foo");

      // Navigate to /bar
      let B = await t.navigate("/bar");
      await B.loaders.bar.resolve("BAR");
      expect(t.router.state.location.pathname).toEqual("/bar");

      // Post to /bar (should replace)
      let C = await t.navigate("/bar", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      await C.actions.bar.resolve("BAR ACTION");
      await C.loaders.root.resolve("ROOT");
      await C.loaders.bar.resolve("BAR");
      expect(t.router.state.location.pathname).toEqual("/bar");

      // POP to /foo
      let D = await t.navigate(-1);
      await D.loaders.foo.resolve("FOO");
      expect(t.router.state.location.pathname).toEqual("/foo");
    });

    it("navigates correctly using POP navigations across action errors", async () => {
      let t = initializeTmTest();

      // Navigate to /foo
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve("FOO");
      expect(t.router.state.location.pathname).toEqual("/foo");

      // Navigate to /bar
      let B = await t.navigate("/bar");
      await B.loaders.bar.resolve("BAR");
      expect(t.router.state.location.pathname).toEqual("/bar");

      // Post to /bar (should push due to our error)
      let C = await t.navigate("/bar", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      await C.actions.bar.reject("BAR ERROR");
      await C.loaders.root.resolve("ROOT");
      await C.loaders.bar.resolve("BAR");
      expect(t.router.state.location.pathname).toEqual("/bar");

      // POP to /bar
      let D = await t.navigate(-1);
      await D.loaders.bar.resolve("BAR");
      expect(t.router.state.location.pathname).toEqual("/bar");
    });

    it("navigates correctly using POP navigations across loader redirects", async () => {
      // Start at / (history stack: [/])
      let t = initializeTmTest();

      // Navigate to /foo (history stack: [/, /foo])
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve("FOO");
      expect(t.router.state.location.pathname).toEqual("/foo");
      let fooKey = t.router.state.location?.key;

      // Navigate to /bar, redirect to /baz (history stack: [/, /foo, /baz])
      let B = await t.navigate("/bar");
      let C = await B.loaders.bar.redirect("/baz");
      await C.loaders.root.resolve("ROOT");
      await C.loaders.baz.resolve("BAZ");
      expect(t.router.state.location.pathname).toEqual("/baz");

      // POP to /foo (history stack: [/, /foo])
      let E = await t.navigate(-1);
      await E.loaders.foo.resolve("FOO");
      expect(t.router.state.location.pathname).toEqual("/foo");
      expect(t.router.state.location.key).toBe(fooKey);
    });

    it("navigates correctly using POP navigations across loader redirects with replace:true", async () => {
      // Start at / (history stack: [/])
      let t = initializeTmTest();
      let indexKey = t.router.state.location?.key;

      // Navigate to /foo (history stack: [/, /foo])
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve("FOO");
      expect(t.router.state.historyAction).toEqual("PUSH");
      expect(t.router.state.location.pathname).toEqual("/foo");

      // Navigate to /bar, redirect to /baz (history stack: [/, /baz])
      let B = await t.navigate("/bar", { replace: true });
      let C = await B.loaders.bar.redirect("/baz");
      await C.loaders.root.resolve("ROOT");
      await C.loaders.baz.resolve("BAZ");
      expect(t.router.state.historyAction).toEqual("REPLACE");
      expect(t.router.state.location.pathname).toEqual("/baz");

      // POP to / (history stack: [/])
      let E = await t.navigate(-1);
      await E.loaders.index.resolve("INDEX");
      expect(t.router.state.historyAction).toEqual("POP");
      expect(t.router.state.location.pathname).toEqual("/");
      expect(t.router.state.location.key).toBe(indexKey);
    });

    it("navigates correctly using POP navigations across action redirects", async () => {
      let t = initializeTmTest();

      // Navigate to /foo
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve("FOO");
      expect(t.router.state.location.pathname).toEqual("/foo");

      // Navigate to /bar
      let B = await t.navigate("/bar");
      let getBarKey = t.router.state.navigation.location?.key;
      await B.loaders.bar.resolve("BAR");
      expect(t.router.state.historyAction).toEqual("PUSH");
      expect(t.router.state.location.pathname).toEqual("/bar");

      // Post to /bar, redirect to /baz
      let C = await t.navigate("/bar", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      let postBarKey = t.router.state.navigation.location?.key;
      let D = await C.actions.bar.redirect("/baz");
      await D.loaders.root.resolve("ROOT");
      await D.loaders.baz.resolve("BAZ");
      expect(t.router.state.historyAction).toEqual("PUSH");
      expect(t.router.state.location.pathname).toEqual("/baz");

      // POP to /bar
      let E = await t.navigate(-1);
      await E.loaders.bar.resolve("BAR");
      expect(t.router.state.historyAction).toEqual("POP");
      expect(t.router.state.location.pathname).toEqual("/bar");
      expect(t.router.state.location.key).toBe(getBarKey);
      expect(t.router.state.location.key).not.toBe(postBarKey);
    });

    it("navigates correctly using POP navigations across <Form replace> redirects", async () => {
      let t = initializeTmTest();

      // Navigate to /foo
      let A = await t.navigate("/foo");
      await A.loaders.foo.resolve("FOO");
      expect(t.router.state.location.pathname).toEqual("/foo");

      // Navigate to /bar
      let B = await t.navigate("/bar");
      await B.loaders.bar.resolve("BAR");
      expect(t.router.state.historyAction).toEqual("PUSH");
      expect(t.router.state.location.pathname).toEqual("/bar");

      // Post to /bar, redirect to /baz
      let C = await t.navigate("/bar", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
        replace: true,
      });
      let D = await C.actions.bar.redirect("/baz");
      await D.loaders.root.resolve("ROOT");
      await D.loaders.baz.resolve("BAZ");
      expect(t.router.state.historyAction).toEqual("REPLACE");
      expect(t.router.state.location.pathname).toEqual("/baz");

      // POP to /foo
      let E = await t.navigate(-1);
      await E.loaders.foo.resolve("FOO");
      expect(t.router.state.historyAction).toEqual("POP");
      expect(t.router.state.location.pathname).toEqual("/foo");
    });
  });

  describe("submission navigations", () => {
    it("reloads all routes when a loader during an actionReload redirects", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);

      await A.actions.foo.resolve("FOO ACTION");
      expect(A.loaders.root.stub.mock.calls.length).toBe(1);

      let B = await A.loaders.foo.redirect("/bar");
      await A.loaders.root.reject("ROOT ERROR");
      await B.loaders.root.resolve("ROOT LOADER 2");
      await B.loaders.bar.resolve("BAR LOADER");
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);
      expect(t.router.state).toMatchObject({
        loaderData: {
          root: "ROOT LOADER 2",
          bar: "BAR LOADER",
        },
        errors: {},
      });
    });

    it("commits action data as soon as it lands", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      expect(t.router.state.actionData).toBeNull();

      await A.actions.foo.resolve("A");
      expect(t.router.state.actionData).toEqual({
        foo: "A",
      });
    });

    it("reloads all routes after the action", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);

      await A.actions.foo.resolve(null);
      expect(A.loaders.root.stub.mock.calls.length).toBe(1);

      await A.loaders.foo.resolve("A LOADER");
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT", // old data
        index: "INDEX", // old data
      });

      await A.loaders.root.resolve("ROOT LOADER");
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.loaderData).toEqual({
        foo: "A LOADER",
        root: "ROOT LOADER",
      });
    });

    it("reloads all routes after action redirect (throw)", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);

      let B = await A.actions.foo.redirect("/bar");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);

      await B.loaders.root.resolve("ROOT LOADER");
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT", // old data
        index: "INDEX", // old data
      });

      await B.loaders.bar.resolve("B LOADER");
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.loaderData).toEqual({
        bar: "B LOADER",
        root: "ROOT LOADER",
      });
    });

    it("reloads all routes after action redirect (return)", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);

      let B = await A.actions.foo.redirectReturn("/bar");
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);

      await B.loaders.root.resolve("ROOT LOADER");
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT", // old data
        index: "INDEX", // old data
      });

      await B.loaders.bar.resolve("B LOADER");
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.loaderData).toEqual({
        bar: "B LOADER",
        root: "ROOT LOADER",
      });
    });

    it("reloads all routes after action redirect (chained redirects)", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      expect(A.loaders.root.stub.mock.calls.length).toBe(0);

      let B = await A.actions.foo.redirectReturn("/bar");
      expect(B.loaders.root.stub.mock.calls.length).toBe(1);

      await B.loaders.root.resolve("ROOT*");
      let C = await B.loaders.bar.redirectReturn("/baz");
      expect(C.loaders.root.stub.mock.calls.length).toBe(1);

      await C.loaders.root.resolve("ROOT**");
      await C.loaders.baz.resolve("BAZ");
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.loaderData).toEqual({
        baz: "BAZ",
        root: "ROOT**",
      });
    });

    it("removes action data at new locations", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      await A.actions.foo.resolve("A ACTION");
      await A.loaders.root.resolve("A ROOT");
      await A.loaders.foo.resolve("A LOADER");
      expect(t.router.state.actionData).toEqual({ foo: "A ACTION" });

      let B = await t.navigate("/bar");
      await B.loaders.bar.resolve("B LOADER");
      expect(t.router.state.actionData).toBeNull();
    });

    it("uses the proper action for index routes", async () => {
      let t = setup({
        routes: [
          {
            path: "/",
            id: "parent",
            children: [
              {
                path: "/child",
                id: "child",
                hasErrorBoundary: true,
                action: true,
                children: [
                  {
                    index: true,
                    id: "childIndex",
                    hasErrorBoundary: true,
                    action: true,
                  },
                ],
              },
            ],
          },
        ],
      });
      let A = await t.navigate("/child", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      await A.actions.child.resolve("CHILD");
      expect(t.router.state.actionData).toEqual({
        child: "CHILD",
      });

      let B = await t.navigate("/child?index", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      await B.actions.childIndex.resolve("CHILD INDEX");
      expect(t.router.state.actionData).toEqual({
        childIndex: "CHILD INDEX",
      });
    });

    it("retains the index match when submitting to a layout route", async () => {
      let t = setup({
        routes: [
          {
            path: "/",
            id: "parent",
            loader: true,
            action: true,
            children: [
              {
                path: "/child",
                id: "child",
                loader: true,
                action: true,
                children: [
                  {
                    index: true,
                    id: "childIndex",
                    loader: true,
                    action: true,
                  },
                ],
              },
            ],
          },
        ],
      });
      let A = await t.navigate("/child", {
        formMethod: "post",
        formData: new FormData(),
      });
      await A.actions.child.resolve("CHILD ACTION");
      await A.loaders.parent.resolve("PARENT LOADER");
      await A.loaders.child.resolve("CHILD LOADER");
      await A.loaders.childIndex.resolve("CHILD INDEX LOADER");
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.loaderData).toEqual({
        parent: "PARENT LOADER",
        child: "CHILD LOADER",
        childIndex: "CHILD INDEX LOADER",
      });
      expect(t.router.state.actionData).toEqual({
        child: "CHILD ACTION",
      });
      expect(t.router.state.matches.map((m) => m.route.id)).toEqual([
        "parent",
        "child",
        "childIndex",
      ]);
    });
  });

  describe("action errors", () => {
    describe("with an error boundary in the action route", () => {
      it("uses the action route's error boundary", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              children: [
                {
                  path: "/child",
                  id: "child",
                  hasErrorBoundary: true,
                  action: true,
                },
              ],
            },
          ],
        });
        let A = await t.navigate("/child", {
          formMethod: "post",
          formData: createFormData({ gosh: "dang" }),
        });
        await A.actions.child.reject(new Error("Kaboom!"));
        expect(t.router.state.errors).toEqual({
          child: new Error("Kaboom!"),
        });
      });

      it("loads parent data, but not action data", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              loader: true,
              children: [
                {
                  path: "/child",
                  id: "child",
                  hasErrorBoundary: true,
                  loader: true,
                  action: true,
                },
              ],
            },
          ],
        });
        let A = await t.navigate("/child", {
          formMethod: "post",
          formData: createFormData({ gosh: "dang" }),
        });
        await A.actions.child.reject(new Error("Kaboom!"));
        expect(A.loaders.parent.stub.mock.calls.length).toBe(1);
        expect(A.loaders.child.stub.mock.calls.length).toBe(0);
        await A.loaders.parent.resolve("PARENT LOADER");
        expect(t.router.state).toMatchObject({
          loaderData: {
            parent: "PARENT LOADER",
          },
          actionData: null,
          errors: {
            child: new Error("Kaboom!"),
          },
        });
      });
    });

    describe("with an error boundary above the action route", () => {
      it("uses the nearest error boundary", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              hasErrorBoundary: true,
              children: [
                {
                  path: "/child",
                  id: "child",
                  action: true,
                },
              ],
            },
          ],
        });
        let A = await t.navigate("/child", {
          formMethod: "post",
          formData: createFormData({ gosh: "dang" }),
        });
        await A.actions.child.reject(new Error("Kaboom!"));
        expect(t.router.state.errors).toEqual({
          parent: new Error("Kaboom!"),
        });
      });
    });

    describe("with a parent loader that throws also, good grief!", () => {
      it("uses action error but nearest errorBoundary to parent", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "root",
              hasErrorBoundary: true,
              children: [
                {
                  path: "/parent",
                  id: "parent",
                  loader: true,
                  children: [
                    {
                      path: "/parent/child",
                      id: "child",
                      action: true,
                      hasErrorBoundary: true,
                    },
                  ],
                },
              ],
            },
          ],
        });

        let A = await t.navigate("/parent/child", {
          formMethod: "post",
          formData: createFormData({ gosh: "dang" }),
        });
        await A.actions.child.reject(new Error("Kaboom!"));
        await A.loaders.parent.reject(new Error("Should not see this!"));
        expect(t.router.state).toMatchObject({
          loaderData: {},
          actionData: {},
          errors: {
            root: new Error("Kaboom!"),
          },
        });
      });
    });

    describe("with no corresponding action", () => {
      it("throws a 405 ErrorResponse", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              children: [
                {
                  path: "/child",
                  id: "child",
                  hasErrorBoundary: true,
                },
              ],
            },
          ],
        });
        let spy = jest.spyOn(console, "warn").mockImplementation(() => {});
        await t.navigate("/child", {
          formMethod: "post",
          formData: createFormData({ gosh: "dang" }),
        });
        expect(t.router.state.errors).toEqual({
          child: new ErrorResponse(
            405,
            "Method Not Allowed",
            "No action found for [/child]"
          ),
        });
        expect(console.warn).toHaveBeenCalled();
        spy.mockReset();
      });

      it("still calls appropriate loaders after 405 ErrorResponse", async () => {
        let t = setup({
          routes: [
            {
              path: "/",
              id: "parent",
              loader: true,
              children: [
                {
                  path: "child",
                  id: "child",
                  loader: true,
                  children: [
                    {
                      path: "grandchild",
                      id: "grandchild",
                      loader: true,
                      // no action to post to
                      hasErrorBoundary: true,
                    },
                  ],
                },
              ],
            },
          ],
          hydrationData: {
            loaderData: {
              parent: "PARENT DATA",
            },
          },
        });
        let A = await t.navigate("/child/grandchild", {
          formMethod: "post",
          formData: createFormData({ gosh: "dang" }),
        });
        expect(t.router.state.errors).toBe(null);
        expect(A.loaders.parent.stub.mock.calls.length).toBe(1); // called again for revalidation
        expect(A.loaders.child.stub.mock.calls.length).toBe(1); // called because it's above error
        expect(A.loaders.grandchild.stub.mock.calls.length).toBe(0); // don't call due to error
        await A.loaders.parent.resolve("PARENT DATA*");
        await A.loaders.child.resolve("CHILD DATA");
        expect(t.router.state.loaderData).toEqual({
          parent: "PARENT DATA*",
          child: "CHILD DATA",
        });
        expect(t.router.state.actionData).toBe(null);
        expect(t.router.state.errors).toEqual({
          grandchild: new ErrorResponse(
            405,
            "Method Not Allowed",
            "No action found for [/child/grandchild]"
          ),
        });
      });
    });
  });

  describe("navigation states", () => {
    it("initialization", async () => {
      let t = initializeTmTest();
      let navigation = t.router.state.navigation;
      expect(navigation.state).toBe("idle");
      expect(navigation.formData).toBeUndefined();
      expect(navigation.location).toBeUndefined();
    });

    it("get", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo");
      let navigation = t.router.state.navigation;
      expect(navigation.state).toBe("loading");
      expect(navigation.formData).toBeUndefined();
      expect(navigation.location).toMatchObject({
        pathname: "/foo",
        search: "",
        hash: "",
      });

      await A.loaders.foo.resolve("A");
      navigation = t.router.state.navigation;
      expect(navigation.state).toBe("idle");
      expect(navigation.formData).toBeUndefined();
      expect(navigation.location).toBeUndefined();
    });

    it("get + redirect", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo");
      let B = await A.loaders.foo.redirect("/bar");

      let navigation = t.router.state.navigation;
      expect(navigation.state).toBe("loading");
      expect(navigation.formData).toBeUndefined();
      expect(navigation.location?.pathname).toBe("/bar");

      await B.loaders.bar.resolve("B");
      navigation = t.router.state.navigation;
      expect(navigation.state).toBe("idle");
      expect(navigation.formData).toBeUndefined();
      expect(navigation.location).toBeUndefined();
    });

    it("action submission", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      let navigation = t.router.state.navigation;
      expect(navigation.state).toBe("submitting");

      expect(
        // @ts-expect-error
        new URLSearchParams(navigation.formData).toString()
      ).toBe("gosh=dang");
      expect(navigation.formMethod).toBe("post");
      expect(navigation.formEncType).toBe("application/x-www-form-urlencoded");
      expect(navigation.location).toMatchObject({
        pathname: "/foo",
        search: "",
        hash: "",
      });

      await A.actions.foo.resolve("A");
      navigation = t.router.state.navigation;
      expect(navigation.state).toBe("loading");
      expect(
        // @ts-expect-error
        new URLSearchParams(navigation.formData).toString()
      ).toBe("gosh=dang");
      expect(navigation.formMethod).toBe("post");
      expect(navigation.formEncType).toBe("application/x-www-form-urlencoded");
      expect(navigation.location).toMatchObject({
        pathname: "/foo",
        search: "",
        hash: "",
      });

      await A.loaders.foo.resolve("A");
      navigation = t.router.state.navigation;
      expect(navigation.state).toBe("loading");

      await A.loaders.root.resolve("B");
      navigation = t.router.state.navigation;
      expect(navigation.state).toBe("idle");
      expect(navigation.formData).toBeUndefined();
      expect(navigation.location).toBeUndefined();
    });

    it("action submission + redirect", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ gosh: "dang" }),
      });
      let B = await A.actions.foo.redirect("/bar");

      let navigation = t.router.state.navigation;
      expect(navigation.state).toBe("loading");
      expect(
        // @ts-expect-error
        new URLSearchParams(navigation.formData).toString()
      ).toBe("gosh=dang");
      expect(navigation.formMethod).toBe("post");
      expect(navigation.location).toMatchObject({
        pathname: "/bar",
        search: "",
        hash: "",
      });

      await B.loaders.bar.resolve("B");
      navigation = t.router.state.navigation;
      expect(navigation.state).toBe("loading");

      await B.loaders.root.resolve("C");
      navigation = t.router.state.navigation;
      expect(navigation.state).toBe("idle");
      expect(navigation.formData).toBeUndefined();
      expect(navigation.location).toBeUndefined();
    });

    it("loader submission", async () => {
      let t = initializeTmTest();
      let A = await t.navigate("/foo", {
        formData: createFormData({ gosh: "dang" }),
      });
      let navigation = t.router.state.navigation;
      expect(navigation.state).toBe("loading");
      expect(navigation.formData).toBeUndefined();
      expect(navigation.formMethod).toBeUndefined();
      expect(navigation.formEncType).toBeUndefined();
      expect(navigation.location).toMatchObject({
        pathname: "/foo",
        search: "?gosh=dang",
        hash: "",
      });

      await A.loaders.root.resolve("ROOT");
      await A.loaders.foo.resolve("A");
      navigation = t.router.state.navigation;
      expect(navigation.state).toBe("idle");
      expect(navigation.formData).toBeUndefined();
      expect(navigation.location).toBeUndefined();
    });

    it("loader submission + redirect", async () => {
      let t = initializeTmTest();

      let A = await t.navigate("/foo", {
        formData: createFormData({ gosh: "dang" }),
      });
      await A.loaders.root.resolve("ROOT");
      let B = await A.loaders.foo.redirect("/bar");

      let navigation = t.router.state.navigation;
      expect(navigation.state).toBe("loading");
      expect(navigation.formData).toBeUndefined();
      expect(navigation.formMethod).toBeUndefined();
      expect(navigation.formEncType).toBeUndefined();
      expect(navigation.location?.pathname).toBe("/bar");

      await B.loaders.bar.resolve("B");
      navigation = t.router.state.navigation;
      expect(navigation.state).toBe("idle");
      expect(navigation.formData).toBeUndefined();
      expect(navigation.location).toBeUndefined();
    });
  });

  describe("interruptions", () => {
    describe(`
      A) GET /foo |---X
      B) GET /bar     |---O
    `, () => {
      it("aborts previous load", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo");
        t.navigate("/bar");
        expect(A.loaders.foo.stub.mock.calls.length).toBe(1);
      });
    });

    describe(`
      A) GET  /foo |---X
      B) POST /bar     |---O
    `, () => {
      it("aborts previous load", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo");
        await t.navigate("/bar", {
          formMethod: "post",
          formData: new FormData(),
        });
        expect(A.loaders.foo.signal.aborted).toBe(true);
      });
    });

    describe(`
      A) POST /foo |---X
      B) POST /bar     |---O
    `, () => {
      it("aborts previous action", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: new FormData(),
        });
        await t.navigate("/bar", {
          formMethod: "post",
          formData: new FormData(),
        });
        expect(A.actions.foo.signal.aborted).toBe(true);
      });
    });

    describe(`
      A) POST /foo |--|--X
      B) GET  /bar       |---O
    `, () => {
      it("aborts previous action reload", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: new FormData(),
        });
        await A.actions.foo.resolve("A ACTION");
        await t.navigate("/bar");
        expect(A.loaders.foo.signal.aborted).toBe(true);
      });
    });

    describe(`
      A) POST /foo |--|--X
      B) POST /bar       |---O
    `, () => {
      it("aborts previous action reload", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: new FormData(),
        });
        await A.actions.foo.resolve("A ACTION");
        await t.navigate("/bar", {
          formMethod: "post",
          formData: new FormData(),
        });
        expect(A.loaders.foo.signal.aborted).toBe(true);
      });
    });

    describe(`
      A) GET /foo |--/bar--X
      B) GET /baz          |---O
    `, () => {
      it("aborts previous action redirect load", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo");
        let AR = await A.loaders.foo.redirect("/bar");
        t.navigate("/baz");
        expect(AR.loaders.bar.stub.mock.calls.length).toBe(1);
      });
    });

    describe(`
      A) POST /foo |--/bar--X
      B) GET  /baz          |---O
    `, () => {
      it("aborts previous action redirect load", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: new FormData(),
        });
        let AR = await A.actions.foo.redirect("/bar");
        await t.navigate("/baz");
        expect(AR.loaders.bar.signal.aborted).toBe(true);
      });
    });

    describe(`
      A) GET /foo |---X
      B) GET /bar     |---X
      C) GET /baz         |---O
    `, () => {
      it("aborts multiple subsequent loads", async () => {
        let t = initializeTmTest();
        // Start A navigation and immediately interrupt
        let A = await t.navigate("/foo");
        let B = await t.navigate("/bar");
        // resolve A then interrupt B - ensure the A resolution doesn't clear
        // the new pendingNavigationController which is now reflecting B's nav
        await A.loaders.foo.resolve("A");
        let C = await t.navigate("/baz");
        await B.loaders.bar.resolve("B");
        await C.loaders.baz.resolve("C");

        expect(A.loaders.foo.stub.mock.calls.length).toBe(1);
        expect(A.loaders.foo.signal.aborted).toBe(true);

        expect(B.loaders.bar.stub.mock.calls.length).toBe(1);
        expect(B.loaders.bar.signal.aborted).toBe(true);

        expect(C.loaders.baz.stub.mock.calls.length).toBe(1);
        expect(C.loaders.baz.signal.aborted).toBe(false);

        expect(t.router.state.loaderData).toEqual({
          root: "ROOT",
          baz: "C",
        });
      });
    });

    describe(`
      A) POST /foo |---X
      B) POST /bar     |---X
      C) POST /baz         |---O
    `, () => {
      it("aborts previous load", async () => {
        let t = initializeTmTest();
        // Start A navigation and immediately interrupt
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: new FormData(),
        });
        let B = await t.navigate("/bar", {
          formMethod: "post",
          formData: new FormData(),
        });
        // resolve A then interrupt B - ensure the A resolution doesn't clear
        // the new pendingNavigationController which is now reflecting B's nav
        await A.actions.foo.resolve("A");
        let C = await t.navigate("/baz", {
          formMethod: "post",
          formData: new FormData(),
        });
        await B.actions.bar.resolve("B");
        await C.actions.baz.resolve("C");

        expect(A.actions.foo.stub.mock.calls.length).toBe(1);
        expect(A.actions.foo.signal.aborted).toBe(true);

        expect(B.actions.bar.stub.mock.calls.length).toBe(1);
        expect(B.actions.bar.signal.aborted).toBe(true);

        expect(C.actions.baz.stub.mock.calls.length).toBe(1);
        expect(C.actions.baz.signal.aborted).toBe(false);

        expect(t.router.state.actionData).toEqual({
          baz: "C",
        });
      });
    });

    describe(`
      A) POST /foo |--X
      B) GET  /bar    |-----O
    `, () => {
      it("forces all loaders to revalidate on interrupted submission", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        // Interrupting the submission should cause the next load to call all loaders
        let B = await t.navigate("/bar");
        await A.actions.foo.resolve("A ACTION");
        await B.loaders.root.resolve("ROOT*");
        await B.loaders.bar.resolve("BAR");
        expect(t.router.state).toMatchObject({
          navigation: IDLE_NAVIGATION,
          location: { pathname: "/bar" },
          actionData: null,
          loaderData: {
            root: "ROOT*",
            bar: "BAR",
          },
        });
      });
    });

    describe(`
      A) POST /foo |--|--X
      B) GET  /bar       |-----O
    `, () => {
      it("forces all loaders to revalidate on interrupted actionReload", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        await A.actions.foo.resolve("A ACTION");
        expect(t.router.state.navigation.state).toBe("loading");
        // Interrupting the actionReload should cause the next load to call all loaders
        let B = await t.navigate("/bar");
        await B.loaders.root.resolve("ROOT*");
        await B.loaders.bar.resolve("BAR");
        expect(t.router.state).toMatchObject({
          navigation: IDLE_NAVIGATION,
          location: { pathname: "/bar" },
          actionData: null,
          loaderData: {
            root: "ROOT*",
            bar: "BAR",
          },
        });
      });

      it("forces all loaders to revalidate on interrupted submissionRedirect", async () => {
        let t = initializeTmTest();
        let A = await t.navigate("/foo", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        await A.actions.foo.redirect("/baz");
        expect(t.router.state.navigation.state).toBe("loading");
        // Interrupting the submissionRedirect should cause the next load to call all loaders
        let B = await t.navigate("/bar");
        await B.loaders.root.resolve("ROOT*");
        await B.loaders.bar.resolve("BAR");
        expect(t.router.state).toMatchObject({
          navigation: IDLE_NAVIGATION,
          location: { pathname: "/bar" },
          loaderData: {
            root: "ROOT*",
            bar: "BAR",
          },
        });
      });
    });
  });

  describe("navigation (new)", () => {
    it("navigates through a history stack without data loading", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
          },
          {
            id: "tasks",
            path: "tasks",
          },
          {
            id: "tasksId",
            path: "tasks/:id",
          },
        ],
        initialEntries: ["/"],
      });

      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        navigation: IDLE_NAVIGATION,
        loaderData: {},
        matches: [expect.objectContaining({ pathname: "/" })],
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await t.navigate("/tasks");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: {
          pathname: "/tasks",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        navigation: IDLE_NAVIGATION,
        loaderData: {},
        matches: [expect.objectContaining({ pathname: "/tasks" })],
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks");

      await t.navigate("/tasks/1", { replace: true });
      expect(t.router.state).toMatchObject({
        historyAction: "REPLACE",
        location: {
          pathname: "/tasks/1",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        navigation: IDLE_NAVIGATION,
        loaderData: {},
        matches: [expect.objectContaining({ pathname: "/tasks/1" })],
      });
      expect(t.history.action).toEqual("REPLACE");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      t.router.navigate(-1);
      await tick();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
          search: "",
          hash: "",
          state: null,
          key: expect.any(String),
        },
        navigation: IDLE_NAVIGATION,
        loaderData: {},
        matches: [expect.objectContaining({ pathname: "/" })],
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await t.navigate("/tasks?foo=bar#hash");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: {
          pathname: "/tasks",
          search: "?foo=bar",
          hash: "#hash",
          state: null,
          key: expect.any(String),
        },
        navigation: IDLE_NAVIGATION,
        loaderData: {},
        matches: [expect.objectContaining({ pathname: "/tasks" })],
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location).toEqual({
        pathname: "/tasks",
        search: "?foo=bar",
        hash: "#hash",
        state: null,
        key: expect.any(String),
      });
    });

    it("navigates through a history stack without data loading (with a basename)", async () => {
      let t = setup({
        basename: "/base/name",
        routes: [
          {
            id: "index",
            index: true,
          },
          {
            id: "tasks",
            path: "tasks",
          },
          {
            id: "tasksId",
            path: "tasks/:id",
          },
        ],
        initialEntries: ["/base/name"],
      });

      expect(t.router.state).toMatchObject({
        location: {
          pathname: "/base/name",
        },
        matches: [{ route: { id: "index" } }],
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/base/name");

      await t.navigate("/base/name/tasks");
      expect(t.router.state).toMatchObject({
        location: {
          pathname: "/base/name/tasks",
        },
        matches: [{ route: { id: "tasks" } }],
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/base/name/tasks");

      await t.navigate("/base/name/tasks/1");
      expect(t.router.state).toMatchObject({
        location: {
          pathname: "/base/name/tasks/1",
        },
        matches: [{ route: { id: "tasksId" } }],
      });
      expect(t.history.location.pathname).toEqual("/base/name/tasks/1");
    });

    it("handles 404 routes", () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
      });
      t.navigate("/junk");
      expect(t.router.state).toMatchObject({
        location: {
          pathname: "/junk",
        },
        navigation: IDLE_NAVIGATION,
        loaderData: {},
        errors: {
          root: {
            status: 404,
            statusText: "Not Found",
            data: null,
          },
        },
      });
    });

    it("converts formData to URLSearchParams for unspecified formMethod", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
      });
      await t.navigate("/tasks", {
        formData: createFormData({ key: "value" }),
      });
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.navigation.location).toMatchObject({
        pathname: "/tasks",
        search: "?key=value",
      });
      expect(t.router.state.navigation.formMethod).toBeUndefined();
      expect(t.router.state.navigation.formData).toBeUndefined();
    });

    it("converts formData to URLSearchParams for formMethod=get", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
      });
      await t.navigate("/tasks", {
        formMethod: "get",
        formData: createFormData({ key: "value" }),
      });
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.navigation.location).toMatchObject({
        pathname: "/tasks",
        search: "?key=value",
      });
      expect(t.router.state.navigation.formMethod).toBeUndefined();
      expect(t.router.state.navigation.formData).toBeUndefined();
    });

    it("does not preserve existing 'action' URLSearchParams for formMethod='get'", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
      });
      await t.navigate("/tasks?key=1", {
        formMethod: "get",
        formData: createFormData({ key: "2" }),
      });
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.navigation.location).toMatchObject({
        pathname: "/tasks",
        search: "?key=2",
      });
      expect(t.router.state.navigation.formMethod).toBeUndefined();
      expect(t.router.state.navigation.formData).toBeUndefined();
    });

    it("preserves existing 'action' URLSearchParams for formMethod='post'", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
      });
      await t.navigate("/tasks?key=1", {
        formMethod: "post",
        formData: createFormData({ key: "2" }),
      });
      expect(t.router.state.navigation.state).toBe("submitting");
      expect(t.router.state.navigation.location).toMatchObject({
        pathname: "/tasks",
        search: "?key=1",
      });
      expect(t.router.state.navigation.formMethod).toBe("post");
      expect(t.router.state.navigation.formData).toEqual(
        createFormData({ key: "2" })
      );
    });

    it("returns a 400 error if binary data is attempted to be submitted using formMethod=GET", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT DATA",
            index: "INDEX DATA",
          },
        },
      });

      let formData = new FormData();
      formData.append(
        "blob",
        new Blob(["<h1>Some html file contents</h1>"], {
          type: "text/html",
        })
      );

      await t.navigate("/tasks", {
        formMethod: "get",
        formData: formData,
      });
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.location).toMatchObject({
        pathname: "/tasks",
        search: "",
      });
      expect(t.router.state.errors).toEqual({
        tasks: new ErrorResponse(
          400,
          "Bad Request",
          "Cannot submit binary form data using GET"
        ),
      });
    });

    it("runs loaders above the boundary for 400 errors if binary data is attempted to be submitted using formMethod=GET", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
          },
          {
            id: "parent",
            path: "parent",
            loader: true,
            children: [
              {
                id: "child",
                path: "child",
                loader: true,
                hasErrorBoundary: true,
              },
            ],
          },
        ],
        initialEntries: ["/"],
      });

      let formData = new FormData();
      formData.append(
        "blob",
        new Blob(["<h1>Some html file contents</h1>"], {
          type: "text/html",
        })
      );

      let A = await t.navigate("/parent/child", {
        formMethod: "get",
        formData: formData,
      });
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.errors).toEqual(null);

      await A.loaders.parent.resolve("PARENT");
      expect(A.loaders.child.stub).not.toHaveBeenCalled();
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.loaderData).toEqual({
        parent: "PARENT",
      });
      expect(t.router.state.errors).toEqual({
        child: new ErrorResponse(
          400,
          "Bad Request",
          "Cannot submit binary form data using GET"
        ),
      });
    });
  });

  describe("data loading (new)", () => {
    it("marks as initialized immediately when no loaders are present", async () => {
      let t = setup({
        routes: [
          {
            id: "root",
            path: "/",
          },
        ],
        initialEntries: ["/"],
      });

      expect(console.warn).not.toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        initialized: true,
        navigation: IDLE_NAVIGATION,
        loaderData: {},
      });
    });

    it("hydrates initial data", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT DATA",
            index: "INDEX DATA",
          },
        },
      });

      expect(console.warn).not.toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        initialized: true,
        navigation: IDLE_NAVIGATION,
        loaderData: {
          root: "ROOT DATA",
          index: "INDEX DATA",
        },
      });
    });

    it("kicks off initial data load if no hydration data is provided", async () => {
      let parentDfd = createDeferred();
      let parentSpy = jest.fn(() => parentDfd.promise);
      let childDfd = createDeferred();
      let childSpy = jest.fn(() => childDfd.promise);
      let router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/child"] }),
        routes: [
          {
            path: "/",
            loader: parentSpy,
            children: [
              {
                path: "child",
                loader: childSpy,
              },
            ],
          },
        ],
      });
      router.initialize();

      expect(console.warn).not.toHaveBeenCalled();
      expect(parentSpy.mock.calls.length).toBe(1);
      expect(childSpy.mock.calls.length).toBe(1);
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: false,
        navigation: {
          state: "loading",
          location: { pathname: "/child" },
        },
      });
      expect(router.state.loaderData).toEqual({});

      await parentDfd.resolve("PARENT DATA");
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: false,
        navigation: {
          state: "loading",
          location: { pathname: "/child" },
        },
      });
      expect(router.state.loaderData).toEqual({});

      await childDfd.resolve("CHILD DATA");
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: true,
        navigation: IDLE_NAVIGATION,
        loaderData: {
          "0": "PARENT DATA",
          "0-0": "CHILD DATA",
        },
      });

      router.dispose();
    });

    // This is needed because we can't detect valid "I have a loader" routes
    // in Remix since all routes have a loader to fetch JS bundles but may not
    // actually provide any loaderData
    it("treats partial hydration data as initialized", async () => {
      let parentSpy = jest.fn();
      let childSpy = jest.fn();
      let router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/child"] }),
        routes: [
          {
            path: "/",
            loader: parentSpy,
            children: [
              {
                path: "child",
                loader: childSpy,
              },
            ],
          },
        ],
        hydrationData: {
          loaderData: {
            "0": "PARENT DATA",
          },
        },
      });
      router.initialize();

      expect(parentSpy.mock.calls.length).toBe(0);
      expect(childSpy.mock.calls.length).toBe(0);
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: true,
        navigation: IDLE_NAVIGATION,
      });
      expect(router.state.loaderData).toEqual({
        "0": "PARENT DATA",
      });

      router.dispose();
    });

    it("does not kick off initial data load due to partial hydration if errors exist", async () => {
      let parentDfd = createDeferred();
      let parentSpy = jest.fn(() => parentDfd.promise);
      let childDfd = createDeferred();
      let childSpy = jest.fn(() => childDfd.promise);
      let router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/child"] }),
        routes: [
          {
            path: "/",
            loader: parentSpy,
            children: [
              {
                path: "child",
                loader: childSpy,
              },
            ],
          },
        ],
        hydrationData: {
          errors: {
            "0": "PARENT ERROR",
          },
          loaderData: {
            "0-0": "CHILD_DATA",
          },
        },
      });
      router.initialize();

      expect(console.warn).not.toHaveBeenCalled();
      expect(parentSpy).not.toHaveBeenCalled();
      expect(childSpy).not.toHaveBeenCalled();
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: true,
        navigation: IDLE_NAVIGATION,
        errors: {
          "0": "PARENT ERROR",
        },
        loaderData: {
          "0-0": "CHILD_DATA",
        },
      });

      router.dispose();
    });

    it("handles interruptions of initial data load", async () => {
      let parentDfd = createDeferred();
      let parentSpy = jest.fn(() => parentDfd.promise);
      let childDfd = createDeferred();
      let childSpy = jest.fn(() => childDfd.promise);
      let child2Dfd = createDeferred();
      let child2Spy = jest.fn(() => child2Dfd.promise);
      let router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/child"] }),
        routes: [
          {
            path: "/",
            loader: parentSpy,
            children: [
              {
                path: "child",
                loader: childSpy,
              },
              {
                path: "child2",
                loader: child2Spy,
              },
            ],
          },
        ],
      });
      router.initialize();

      expect(console.warn).not.toHaveBeenCalled();
      expect(parentSpy.mock.calls.length).toBe(1);
      expect(childSpy.mock.calls.length).toBe(1);
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: false,
        navigation: {
          state: "loading",
          location: { pathname: "/child" },
        },
      });
      expect(router.state.loaderData).toEqual({});

      await parentDfd.resolve("PARENT DATA");
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: false,
        navigation: {
          state: "loading",
          location: { pathname: "/child" },
        },
      });
      expect(router.state.loaderData).toEqual({});

      router.navigate("/child2");
      await childDfd.resolve("CHILD DATA");
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: false,
        navigation: {
          state: "loading",
          location: { pathname: "/child2" },
        },
      });
      expect(router.state.loaderData).toEqual({});

      await child2Dfd.resolve("CHILD2 DATA");
      expect(router.state).toMatchObject({
        historyAction: "PUSH",
        location: expect.objectContaining({ pathname: "/child2" }),
        initialized: true,
        navigation: IDLE_NAVIGATION,
        loaderData: {
          "0": "PARENT DATA",
          "0-1": "CHILD2 DATA",
        },
      });

      router.dispose();
    });

    it("handles errors in initial data load", async () => {
      let router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/child"] }),
        routes: [
          {
            path: "/",
            loader: () => Promise.reject("Kaboom!"),
            children: [
              {
                path: "child",
                loader: () => Promise.resolve("child"),
              },
            ],
          },
        ],
      });
      router.initialize();

      await tick();
      expect(router.state).toMatchObject({
        historyAction: "POP",
        location: expect.objectContaining({ pathname: "/child" }),
        initialized: true,
        navigation: IDLE_NAVIGATION,
        loaderData: {
          "0-0": "child",
        },
        errors: {
          "0": "Kaboom!",
        },
      });

      router.dispose();
    });

    it("executes loaders on push navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let nav1 = await t.navigate("/tasks");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        navigation: {
          location: {
            pathname: "/tasks",
          },
          state: "loading",
        },
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await nav1.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: {
          pathname: "/tasks",
        },
        navigation: IDLE_NAVIGATION,
        loaderData: {
          root: "ROOT_DATA",
          tasks: "TASKS_DATA",
        },
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks");

      let nav2 = await t.navigate("/tasks/1");
      await nav2.loaders.tasksId.resolve("TASKS_ID_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: {
          pathname: "/tasks/1",
        },
        navigation: IDLE_NAVIGATION,
        loaderData: {
          root: "ROOT_DATA",
          tasksId: "TASKS_ID_DATA",
        },
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks/1");
    });

    it("executes loaders on replace navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let nav = await t.navigate("/tasks", { replace: true });
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        navigation: {
          location: {
            pathname: "/tasks",
          },
          state: "loading",
        },
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await nav.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "REPLACE",
        location: {
          pathname: "/tasks",
        },
        navigation: IDLE_NAVIGATION,
        loaderData: {
          root: "ROOT_DATA",
          tasks: "TASKS_DATA",
        },
      });
      expect(t.history.action).toEqual("REPLACE");
      expect(t.history.location.pathname).toEqual("/tasks");
    });

    it("executes loaders on go navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/", "/tasks"],
        initialIndex: 0,
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      // pop forward to /tasks
      let nav2 = await t.navigate(1);
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        navigation: {
          location: {
            pathname: "/tasks",
          },
          state: "loading",
        },
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/tasks");

      await nav2.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/tasks",
        },
        navigation: IDLE_NAVIGATION,
        loaderData: {
          root: "ROOT_DATA",
          tasks: "TASKS_DATA",
        },
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/tasks");
    });

    it("persists location keys throughout navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      expect(t.router.state.location.key).toBe("default");

      let A = await t.navigate("/tasks");
      let navigationKey = t.router.state.navigation.location?.key;
      expect(t.router.state.location.key).toBe("default");
      expect(t.router.state.navigation.state).toBe("loading");
      expect(navigationKey).not.toBe("default");
      expect(Number(navigationKey?.length) > 0).toBe(true);

      await A.loaders.tasks.resolve("TASKS");
      expect(t.router.state.navigation.state).toBe("idle");

      // Make sure we keep the same location.key throughout the navigation and
      // history isn't creating a new one in history.push
      expect(t.router.state.location.key).toBe(navigationKey);
      expect(t.history.location.key).toBe(navigationKey);
    });

    it("sends proper arguments to loaders", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      let nav = await t.navigate("/tasks");
      expect(nav.loaders.tasks.stub).toHaveBeenCalledWith({
        params: {},
        request: new Request("http://localhost/tasks", {
          signal: nav.loaders.tasks.stub.mock.calls[0][0].request.signal,
        }),
      });

      let nav2 = await t.navigate("/tasks/1");
      expect(nav2.loaders.tasksId.stub).toHaveBeenCalledWith({
        params: { id: "1" },
        request: new Request("http://localhost/tasks/1", {
          signal: nav2.loaders.tasksId.stub.mock.calls[0][0].request.signal,
        }),
      });

      let nav3 = await t.navigate("/tasks?foo=bar#hash");
      expect(nav3.loaders.tasks.stub).toHaveBeenCalledWith({
        params: {},
        request: new Request("http://localhost/tasks?foo=bar", {
          signal: nav3.loaders.tasks.stub.mock.calls[0][0].request.signal,
        }),
      });
    });

    it("handles errors thrown from loaders", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      // Throw from tasks, handled by tasks
      let nav = await t.navigate("/tasks");
      await nav.loaders.tasks.reject("TASKS_ERROR");
      expect(t.router.state.navigation).toEqual(IDLE_NAVIGATION);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
      });
      expect(t.router.state.errors).toEqual({
        tasks: "TASKS_ERROR",
      });

      // Throw from index, handled by root
      let nav2 = await t.navigate("/");
      await nav2.loaders.index.reject("INDEX_ERROR");
      expect(t.router.state.navigation).toEqual(IDLE_NAVIGATION);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
      });
      expect(t.router.state.errors).toEqual({
        root: "INDEX_ERROR",
      });
    });

    it("re-runs loaders on post-error navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          errors: {
            root: "ROOT_ERROR",
          },
        },
      });

      // If a route has an error, we should call the loader if that route is
      // re-used on a navigation
      let nav = await t.navigate("/tasks");
      await nav.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state.navigation.state).toEqual("loading");
      expect(t.router.state.loaderData).toEqual({});
      expect(t.router.state.errors).toEqual({
        root: "ROOT_ERROR",
      });

      await nav.loaders.root.resolve("ROOT_DATA");
      expect(t.router.state.navigation).toEqual(IDLE_NAVIGATION);
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasks: "TASKS_DATA",
      });
      expect(t.router.state.errors).toBe(null);
    });

    it("handles interruptions during navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let historySpy = jest.spyOn(t.history, "push");

      let nav = await t.navigate("/tasks");
      expect(t.router.state.navigation.state).toEqual("loading");
      expect(t.router.state.location.pathname).toEqual("/");
      expect(nav.loaders.tasks.signal.aborted).toBe(false);
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      // Interrupt and confirm prior loader was aborted
      let nav2 = await t.navigate("/tasks/1");
      expect(t.router.state.navigation.state).toEqual("loading");
      expect(t.router.state.location.pathname).toEqual("/");
      expect(nav.loaders.tasks.signal.aborted).toBe(true);
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      // Complete second navigation
      await nav2.loaders.tasksId.resolve("TASKS_ID_DATA");
      expect(t.router.state.navigation).toEqual(IDLE_NAVIGATION);
      expect(t.router.state.location.pathname).toEqual("/tasks/1");
      expect(t.history.location.pathname).toEqual("/tasks/1");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasksId: "TASKS_ID_DATA",
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      // Resolve first navigation - should no-op
      await nav.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state.navigation).toEqual(IDLE_NAVIGATION);
      expect(t.router.state.location.pathname).toEqual("/tasks/1");
      expect(t.history.location.pathname).toEqual("/tasks/1");
      expect(t.router.state.loaderData).toEqual({
        root: "ROOT_DATA",
        tasksId: "TASKS_ID_DATA",
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks/1");

      expect(historySpy.mock.calls).toEqual([
        [
          expect.objectContaining({
            pathname: "/tasks/1",
          }),
          null,
        ],
      ]);
    });

    it("handles redirects thrown from loaders", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let nav1 = await t.navigate("/tasks");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        navigation: {
          location: {
            pathname: "/tasks",
          },
          state: "loading",
        },
        loaderData: {
          root: "ROOT_DATA",
        },
        errors: null,
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      let nav2 = await nav1.loaders.tasks.redirect("/tasks/1");

      // Should not abort if it redirected
      expect(nav1.loaders.tasks.signal.aborted).toBe(false);
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        navigation: {
          location: {
            pathname: "/tasks/1",
          },
          state: "loading",
        },
        loaderData: {
          root: "ROOT_DATA",
        },
        errors: null,
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await nav2.loaders.tasksId.resolve("TASKS_ID_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: {
          pathname: "/tasks/1",
        },
        navigation: IDLE_NAVIGATION,
        loaderData: {
          root: "ROOT_DATA",
          tasksId: "TASKS_ID_DATA",
        },
        errors: null,
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks/1");
    });

    it("handles redirects returned from loaders", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let nav1 = await t.navigate("/tasks");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        navigation: {
          location: {
            pathname: "/tasks",
          },
          state: "loading",
        },
        loaderData: {
          root: "ROOT_DATA",
        },
        errors: null,
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      let nav2 = await nav1.loaders.tasks.redirectReturn("/tasks/1");

      // Should not abort if it redirected
      expect(nav1.loaders.tasks.signal.aborted).toBe(false);
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: {
          pathname: "/",
        },
        navigation: {
          location: {
            pathname: "/tasks/1",
          },
          state: "loading",
        },
        loaderData: {
          root: "ROOT_DATA",
        },
        errors: null,
      });
      expect(t.history.action).toEqual("POP");
      expect(t.history.location.pathname).toEqual("/");

      await nav2.loaders.tasksId.resolve("TASKS_ID_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: {
          pathname: "/tasks/1",
        },
        navigation: IDLE_NAVIGATION,
        loaderData: {
          root: "ROOT_DATA",
          tasksId: "TASKS_ID_DATA",
        },
        errors: null,
      });
      expect(t.history.action).toEqual("PUSH");
      expect(t.history.location.pathname).toEqual("/tasks/1");
    });

    it("handles thrown non-redirect Responses as ErrorResponse's (text)", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      // Throw from tasks, handled by tasks
      let nav = await t.navigate("/tasks");
      await nav.loaders.tasks.reject(
        new Response("broken", { status: 400, statusText: "Bad Request" })
      );
      expect(t.router.state).toMatchObject({
        navigation: IDLE_NAVIGATION,
        loaderData: {
          root: "ROOT_DATA",
        },
        actionData: null,
        errors: {
          tasks: new ErrorResponse(400, "Bad Request", "broken"),
        },
      });
    });

    it("handles thrown non-redirect Responses as ErrorResponse's (json)", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      // Throw from tasks, handled by tasks
      let nav = await t.navigate("/tasks");
      await nav.loaders.tasks.reject(
        new Response(JSON.stringify({ key: "value" }), {
          status: 400,
          statusText: "Bad Request",
          headers: {
            "Content-Type": "application/json",
          },
        })
      );
      expect(t.router.state).toMatchObject({
        navigation: IDLE_NAVIGATION,
        loaderData: {
          root: "ROOT_DATA",
        },
        actionData: null,
        errors: {
          tasks: new ErrorResponse(400, "Bad Request", { key: "value" }),
        },
      });
    });

    it("handles thrown non-redirect Responses as ErrorResponse's (json utf8)", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      // Throw from tasks, handled by tasks
      let nav = await t.navigate("/tasks");
      await nav.loaders.tasks.reject(
        new Response(JSON.stringify({ key: "value" }), {
          status: 400,
          statusText: "Bad Request",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
        })
      );
      expect(t.router.state).toMatchObject({
        navigation: IDLE_NAVIGATION,
        loaderData: {
          root: "ROOT_DATA",
        },
        actionData: null,
        errors: {
          tasks: new ErrorResponse(400, "Bad Request", { key: "value" }),
        },
      });
    });

    it("sends proper arguments to actions", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      let nav = await t.navigate("/tasks", {
        formMethod: "post",
        formData: createFormData({ query: "params" }),
      });
      expect(nav.actions.tasks.stub).toHaveBeenCalledWith({
        params: {},
        request: expect.any(Request),
      });

      // Assert request internals, cannot do a deep comparison above since some
      // internals aren't the same on separate creations
      let request = nav.actions.tasks.stub.mock.calls[0][0].request;
      expect(request.url).toBe("http://localhost/tasks");
      expect(request.method).toBe("POST");
      expect(request.headers.get("Content-Type")).toBe(
        "application/x-www-form-urlencoded;charset=UTF-8"
      );
      expect((await request.formData()).get("query")).toBe("params");
    });

    it("sends proper arguments to actions (using query string)", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      let formData = createFormData({ query: "params" });

      let nav = await t.navigate("/tasks?foo=bar", {
        formMethod: "post",
        formData,
      });
      expect(nav.actions.tasks.stub).toHaveBeenCalledWith({
        params: {},
        request: expect.any(Request),
      });
      // Assert request internals, cannot do a deep comparison above since some
      // internals aren't the same on separate creations
      let request = nav.actions.tasks.stub.mock.calls[0][0].request;
      expect(request.url).toBe("http://localhost/tasks?foo=bar");
      expect(request.method).toBe("POST");
      expect(request.headers.get("Content-Type")).toBe(
        "application/x-www-form-urlencoded;charset=UTF-8"
      );
      expect((await request.formData()).get("query")).toBe("params");
    });

    it("handles multipart/form-data submissions", async () => {
      let t = setup({
        routes: [
          {
            id: "root",
            path: "/",
            action: true,
          },
        ],
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
          },
        },
      });

      let fd = new FormData();
      fd.append("key", "value");
      fd.append("file", new Blob(["1", "2", "3"]), "file.txt");

      let A = await t.navigate("/", {
        formMethod: "post",
        formEncType: "multipart/form-data",
        formData: fd,
      });

      expect(
        A.actions.root.stub.mock.calls[0][0].request.headers.get("Content-Type")
      ).toMatch(
        /^multipart\/form-data; boundary=NodeFetchFormDataBoundary[a-z0-9]+/
      );
    });

    it("races actions and loaders against abort signals", async () => {
      let loaderDfd = createDeferred();
      let actionDfd = createDeferred();
      let router = createRouter({
        routes: [
          {
            index: true,
          },
          {
            path: "foo",
            loader: () => loaderDfd.promise,
            action: () => actionDfd.promise,
          },
          {
            path: "bar",
          },
        ],
        hydrationData: { loaderData: { "0": null } },
        history: createMemoryHistory(),
      });

      expect(router.state.initialized).toBe(true);

      let fooPromise = router.navigate("/foo");
      expect(router.state.navigation.state).toBe("loading");

      let barPromise = router.navigate("/bar");

      // This should resolve _without_ us resolving the loader
      await fooPromise;
      await barPromise;

      expect(router.state.navigation.state).toBe("idle");
      expect(router.state.location.pathname).toBe("/bar");

      let fooPromise2 = router.navigate("/foo", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      expect(router.state.navigation.state).toBe("submitting");

      let barPromise2 = router.navigate("/bar");

      // This should resolve _without_ us resolving the action
      await fooPromise2;
      await barPromise2;

      expect(router.state.navigation.state).toBe("idle");
      expect(router.state.location.pathname).toBe("/bar");

      router.dispose();
    });
  });

  describe("scroll restoration", () => {
    it("restores scroll on navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      expect(t.router.state.restoreScrollPosition).toBe(null);
      expect(t.router.state.preventScrollReset).toBe(false);

      let positions = {};

      // Simulate scrolling to 100 on /
      let activeScrollPosition = 100;
      t.router.enableScrollRestoration(positions, () => activeScrollPosition);

      // No restoration on first click to /tasks
      let nav1 = await t.navigate("/tasks");
      await nav1.loaders.tasks.resolve("TASKS");
      expect(t.router.state.restoreScrollPosition).toBe(null);
      expect(t.router.state.preventScrollReset).toBe(false);

      // Simulate scrolling down on /tasks
      activeScrollPosition = 200;

      // Restore on pop back to /
      let nav2 = await t.navigate(-1);
      expect(t.router.state.restoreScrollPosition).toBe(null);
      await nav2.loaders.index.resolve("INDEX");
      expect(t.router.state.restoreScrollPosition).toBe(100);
      expect(t.router.state.preventScrollReset).toBe(false);

      // Restore on pop forward to /tasks
      let nav3 = await t.navigate(1);
      await nav3.loaders.tasks.resolve("TASKS");
      expect(t.router.state.restoreScrollPosition).toBe(200);
      expect(t.router.state.preventScrollReset).toBe(false);
    });

    it("restores scroll using custom key", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      expect(t.router.state.restoreScrollPosition).toBe(null);
      expect(t.router.state.preventScrollReset).toBe(false);

      let positions = { "/tasks": 100 };
      let activeScrollPosition = 0;
      t.router.enableScrollRestoration(
        positions,
        () => activeScrollPosition,
        (l) => l.pathname
      );

      let nav1 = await t.navigate("/tasks");
      await nav1.loaders.tasks.resolve("TASKS");
      expect(t.router.state.restoreScrollPosition).toBe(100);
      expect(t.router.state.preventScrollReset).toBe(false);
    });

    it("does not restore scroll on submissions", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      expect(t.router.state.restoreScrollPosition).toBe(null);
      expect(t.router.state.preventScrollReset).toBe(false);

      let positions = { "/tasks": 100 };
      let activeScrollPosition = 0;
      t.router.enableScrollRestoration(
        positions,
        () => activeScrollPosition,
        (l) => l.pathname
      );

      let nav1 = await t.navigate("/tasks", {
        formMethod: "post",
        formData: createFormData({}),
      });
      await nav1.actions.tasks.resolve("ACTION");
      await nav1.loaders.root.resolve("ROOT");
      await nav1.loaders.tasks.resolve("TASKS");
      expect(t.router.state.restoreScrollPosition).toBe(false);
      expect(t.router.state.preventScrollReset).toBe(false);
    });

    it("does not reset scroll", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      expect(t.router.state.restoreScrollPosition).toBe(null);
      expect(t.router.state.preventScrollReset).toBe(false);

      let positions = {};
      let activeScrollPosition = 0;
      t.router.enableScrollRestoration(positions, () => activeScrollPosition);

      let nav1 = await t.navigate("/tasks", { preventScrollReset: true });
      await nav1.loaders.tasks.resolve("TASKS");
      expect(t.router.state.restoreScrollPosition).toBe(null);
      expect(t.router.state.preventScrollReset).toBe(true);
    });
  });

  describe("router.revalidate", () => {
    it("handles uninterrupted revalidation in an idle state (from POP)", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let key = t.router.state.location.key;
      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await R.loaders.root.resolve("ROOT_DATA*");
      await R.loaders.index.resolve("INDEX_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          index: "INDEX_DATA*",
        },
      });
      expect(t.router.state.location.key).toBe(key);
      expect(t.history.push).not.toHaveBeenCalled();
      expect(t.history.replace).not.toHaveBeenCalled();
    });

    it("handles uninterrupted revalidation in an idle state (from PUSH)", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let N = await t.navigate("/");
      await N.loaders.root.resolve("ROOT_DATA");
      await N.loaders.index.resolve("INDEX_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });
      // @ts-expect-error
      expect(t.history.push.mock.calls.length).toBe(1);

      let key = t.router.state.location.key;
      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await R.loaders.root.resolve("ROOT_DATA*");
      await R.loaders.index.resolve("INDEX_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          index: "INDEX_DATA*",
        },
      });
      expect(t.router.state.location.key).toBe(key);
      // @ts-ignore
      expect(t.history.push.mock.calls.length).toBe(1);
      expect(t.history.replace).not.toHaveBeenCalled();
    });

    it("handles revalidation interrupted by a <Link> navigation", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let N = await t.navigate("/tasks");
      // Revalidation was aborted
      expect(R.loaders.root.signal.aborted).toBe(true);
      expect(R.loaders.index.signal.aborted).toBe(true);
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: {
          state: "loading",
          location: { pathname: "/tasks" },
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      // Land the revalidation calls - should no-op
      await R.loaders.root.resolve("ROOT_DATA interrupted");
      await R.loaders.index.resolve("INDEX_DATA interrupted");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: {
          state: "loading",
          location: { pathname: "/tasks" },
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      // Land the navigation calls - should update state and end the revalidation
      await N.loaders.root.resolve("ROOT_DATA*");
      await N.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/tasks" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA",
        },
      });
      expect(t.history.push).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );
    });

    it("handles revalidation interrupted by a <Form method=get> navigation", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let N = await t.navigate("/tasks", {
        formMethod: "get",
        formData: createFormData({ key: "value" }),
      });
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: {
          state: "loading",
          location: {
            pathname: "/tasks",
            search: "?key=value",
          },
          formMethod: undefined,
          formData: undefined,
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });
      await R.loaders.root.resolve("ROOT_DATA interrupted");
      await R.loaders.index.resolve("INDEX_DATA interrupted");
      await N.loaders.root.resolve("ROOT_DATA*");
      await N.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/tasks" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA",
        },
      });
      expect(t.history.push).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );
    });

    it("handles revalidation interrupted by a <Form method=post> navigation", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let N = await t.navigate("/tasks", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: {
          state: "submitting",
          location: { pathname: "/tasks" },
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      // Aborted by the navigation, resolving should no-op
      expect(R.loaders.root.signal.aborted).toBe(true);
      expect(R.loaders.index.signal.aborted).toBe(true);
      await R.loaders.root.resolve("ROOT_DATA interrupted");
      await R.loaders.index.resolve("INDEX_DATA interrupted");

      await N.actions.tasks.resolve("TASKS_ACTION");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: {
          state: "loading",
          location: { pathname: "/tasks" },
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await N.loaders.root.resolve("ROOT_DATA*");
      await N.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "REPLACE",
        location: { pathname: "/tasks" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA",
        },
        actionData: {
          tasks: "TASKS_ACTION",
        },
      });
      expect(t.history.replace).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );
    });

    it("handles <Link> navigation interrupted by a revalidation", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let N = await t.navigate("/tasks");
      expect(N.loaders.root.stub).not.toHaveBeenCalled();
      expect(N.loaders.tasks.stub).toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: { state: "loading" },
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let R = await t.revalidate();
      expect(R.loaders.root.stub).toHaveBeenCalled();
      expect(R.loaders.tasks.stub).toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: { state: "loading" },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await N.loaders.tasks.resolve("TASKS_DATA interrupted");
      await R.loaders.root.resolve("ROOT_DATA*");
      await R.loaders.tasks.resolve("TASKS_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/tasks" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA*",
        },
      });
      expect(t.history.push).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );
    });

    it("handles <Form method=get> navigation interrupted by a revalidation", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let N = await t.navigate("/tasks", {
        formMethod: "get",
        formData: createFormData({ key: "value" }),
      });
      // Called due to search param changing
      expect(N.loaders.root.stub).toHaveBeenCalled();
      expect(N.loaders.tasks.stub).toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: {
          state: "loading",
          location: {
            pathname: "/tasks",
            search: "?key=value",
          },
        },
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let R = await t.revalidate();
      expect(R.loaders.root.stub).toHaveBeenCalled();
      expect(R.loaders.tasks.stub).toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: {
          state: "loading",
          location: {
            pathname: "/tasks",
            search: "?key=value",
          },
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await N.loaders.root.resolve("ROOT_DATA interrupted");
      await N.loaders.tasks.resolve("TASKS_DATA interrupted");
      await R.loaders.root.resolve("ROOT_DATA*");
      await R.loaders.tasks.resolve("TASKS_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/tasks" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA*",
        },
      });
      expect(t.history.push).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );
    });

    it("handles <Form method=post> navigation interrupted by a revalidation during action phase", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let N = await t.navigate("/tasks", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: { state: "submitting" },
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: { state: "submitting" },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await N.actions.tasks.resolve("TASKS_ACTION");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: { state: "loading" },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
        actionData: {
          tasks: "TASKS_ACTION",
        },
      });

      await N.loaders.root.resolve("ROOT_DATA interrupted");
      await N.loaders.tasks.resolve("TASKS_DATA interrupted");
      await R.loaders.root.resolve("ROOT_DATA*");
      await R.loaders.tasks.resolve("TASKS_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "REPLACE",
        location: { pathname: "/tasks" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA*",
        },
      });
      expect(t.history.replace).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );

      // Action was not resubmitted
      expect(N.actions.tasks.stub.mock.calls.length).toBe(1);
      // This is sort of an implementation detail.  Internally we do not start
      // a new navigation, but our helpers return the new "loaders" from the
      // revalidate.  The key here is that together, loaders only got called once
      expect(N.loaders.root.stub.mock.calls.length).toBe(0);
      expect(N.loaders.tasks.stub.mock.calls.length).toBe(0);
      expect(R.loaders.root.stub.mock.calls.length).toBe(1);
      expect(R.loaders.tasks.stub.mock.calls.length).toBe(1);
    });

    it("handles <Form method=post> navigation interrupted by a revalidation during loading phase", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let N = await t.navigate("/tasks", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: { state: "submitting" },
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await N.actions.tasks.resolve("TASKS_ACTION");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: { state: "loading" },
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
        actionData: {
          tasks: "TASKS_ACTION",
        },
      });

      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: { state: "loading" },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
        actionData: {
          tasks: "TASKS_ACTION",
        },
      });

      await N.loaders.root.resolve("ROOT_DATA interrupted");
      await N.loaders.tasks.resolve("TASKS_DATA interrupted");
      await R.loaders.root.resolve("ROOT_DATA*");
      await R.loaders.tasks.resolve("TASKS_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "REPLACE",
        location: { pathname: "/tasks" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          tasks: "TASKS_DATA*",
        },
        actionData: {
          tasks: "TASKS_ACTION",
        },
      });
      expect(t.history.replace).toHaveBeenCalledWith(
        t.router.state.location,
        t.router.state.location.state
      );

      // Action was not resubmitted
      expect(N.actions.tasks.stub.mock.calls.length).toBe(1);
      // Because we interrupted during the loading phase, all loaders got re-called
      expect(N.loaders.root.stub.mock.calls.length).toBe(1);
      expect(N.loaders.tasks.stub.mock.calls.length).toBe(1);
      expect(R.loaders.root.stub.mock.calls.length).toBe(1);
      expect(R.loaders.tasks.stub.mock.calls.length).toBe(1);
    });

    it("handles redirects returned from revalidations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let key = t.router.state.location.key;
      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await R.loaders.root.resolve("ROOT_DATA*");
      let N = await R.loaders.index.redirectReturn("/tasks");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: {
          state: "loading",
        },
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });
      expect(t.router.state.location.key).toBe(key);

      await N.loaders.root.resolve("ROOT_DATA redirect");
      await N.loaders.tasks.resolve("TASKS_DATA");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/tasks" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA redirect",
          tasks: "TASKS_DATA",
        },
      });
      expect(t.router.state.location.key).not.toBe(key);

      let B = await t.navigate(-1);
      await B.loaders.index.resolve("INDEX_DATA 2");
      // PUSH on the revalidation redirect means back button takes us back to
      // the page that triggered the revalidation redirect
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA redirect",
          index: "INDEX_DATA 2",
        },
      });
      expect(t.router.state.location.key).toBe(key);
    });

    it("handles errors from revalidations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let key = t.router.state.location.key;
      let R = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      await R.loaders.root.reject("ROOT_ERROR");
      await R.loaders.index.resolve("INDEX_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA*",
        },
        errors: {
          root: "ROOT_ERROR",
        },
      });
      expect(t.router.state.location.key).toBe(key);
    });

    it("leverages shouldRevalidate on revalidation routes", async () => {
      let shouldRevalidate = jest.fn(({ nextUrl }) => {
        return nextUrl.searchParams.get("reload") === "1";
      });
      let t = setup({
        routes: [
          {
            id: "root",
            loader: true,
            shouldRevalidate: (...args) => shouldRevalidate(...args),
            children: [
              {
                id: "index",
                index: true,
                loader: true,
                shouldRevalidate: (...args) => shouldRevalidate(...args),
              },
            ],
          },
        ],
        initialEntries: ["/?reload=0"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let R = await t.revalidate();
      expect(R.loaders.root.stub).not.toHaveBeenCalled();
      expect(R.loaders.index.stub).not.toHaveBeenCalled();
      expect(t.router.state).toMatchObject({
        historyAction: "POP",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA",
          index: "INDEX_DATA",
        },
      });

      let N = await t.navigate("/?reload=1");
      await N.loaders.root.resolve("ROOT_DATA*");
      await N.loaders.index.resolve("INDEX_DATA*");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA*",
          index: "INDEX_DATA*",
        },
      });

      let R2 = await t.revalidate();
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "loading",
        loaderData: {
          root: "ROOT_DATA*",
          index: "INDEX_DATA*",
        },
      });

      await R2.loaders.root.resolve("ROOT_DATA**");
      await R2.loaders.index.resolve("INDEX_DATA**");
      expect(t.router.state).toMatchObject({
        historyAction: "PUSH",
        location: { pathname: "/" },
        navigation: IDLE_NAVIGATION,
        revalidation: "idle",
        loaderData: {
          root: "ROOT_DATA**",
          index: "INDEX_DATA**",
        },
      });
    });

    it("triggers revalidation on fetcher loads", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT_DATA",
            index: "INDEX_DATA",
          },
        },
      });

      let key = "key";
      let F = await t.fetch("/", key);
      await F.loaders.root.resolve("ROOT_DATA*");
      expect(t.router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: "ROOT_DATA*",
      });

      let R = await t.revalidate();
      await R.loaders.root.resolve("ROOT_DATA**");
      await R.loaders.index.resolve("INDEX_DATA");
      expect(t.router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: "ROOT_DATA**",
      });
    });
  });

  describe("router.dispose", () => {
    it("should cancel pending navigations", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT DATA",
            index: "INDEX DATA",
          },
        },
      });

      let A = await t.navigate("/tasks");
      expect(t.router.state.navigation.state).toBe("loading");

      currentRouter?.dispose();
      expect(A.loaders.tasks.signal.aborted).toBe(true);
    });

    it("should cancel pending fetchers", async () => {
      let t = setup({
        routes: TASK_ROUTES,
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            root: "ROOT DATA",
            index: "INDEX DATA",
          },
        },
      });

      let A = await t.fetch("/tasks");
      let B = await t.fetch("/tasks");

      currentRouter?.dispose();
      expect(A.loaders.tasks.signal.aborted).toBe(true);
      expect(B.loaders.tasks.signal.aborted).toBe(true);
    });
  });

  describe("fetchers", () => {
    describe("fetcher states", () => {
      it("unabstracted loader fetch", async () => {
        let dfd = createDeferred();
        let router = createRouter({
          history: createMemoryHistory({ initialEntries: ["/"] }),
          routes: [
            {
              id: "root",
              path: "/",
              loader: () => dfd.promise,
            },
          ],
          hydrationData: {
            loaderData: { root: "ROOT DATA" },
          },
        });

        let key = "key";
        router.fetch(key, "root", "/");
        expect(router.state.fetchers.get(key)).toEqual({
          state: "loading",
          formMethod: undefined,
          formEncType: undefined,
          formData: undefined,
          data: undefined,
        });

        await dfd.resolve("DATA");
        expect(router.state.fetchers.get(key)).toEqual({
          state: "idle",
          formMethod: undefined,
          formEncType: undefined,
          formData: undefined,
          data: "DATA",
        });

        expect(router._internalFetchControllers.size).toBe(0);
      });

      it("loader fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });

        let A = await t.fetch("/foo");
        expect(A.fetcher.state).toBe("loading");

        await A.loaders.foo.resolve("A DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.data).toBe("A DATA");
      });

      it("loader re-fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let key = "key";

        let A = await t.fetch("/foo", key);
        await A.loaders.foo.resolve("A DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.data).toBe("A DATA");

        let B = await t.fetch("/foo", key);
        expect(B.fetcher.state).toBe("loading");
        expect(B.fetcher.data).toBe("A DATA");

        await B.loaders.foo.resolve("B DATA");
        expect(B.fetcher.state).toBe("idle");
        expect(B.fetcher.data).toBe("B DATA");

        expect(A.fetcher).toBe(B.fetcher);
      });

      it("loader submission fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });

        let A = await t.fetch("/foo", {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        expect(A.fetcher.state).toBe("loading");
        expect(
          new URL(
            A.loaders.foo.stub.mock.calls[0][0].request.url
          ).searchParams.toString()
        ).toBe("key=value");

        await A.loaders.foo.resolve("A DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.data).toBe("A DATA");
      });

      it("loader submission re-fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let key = "key";

        let A = await t.fetch("/foo", key, {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        expect(A.fetcher.state).toBe("loading");
        await A.loaders.foo.resolve("A DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.data).toBe("A DATA");

        let B = await t.fetch("/foo", key, {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        expect(B.fetcher.state).toBe("loading");
        expect(B.fetcher.data).toBe("A DATA");

        await B.loaders.foo.resolve("B DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.data).toBe("B DATA");
      });

      it("action fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });

        let A = await t.fetch("/foo", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(A.fetcher.state).toBe("submitting");

        await A.actions.foo.resolve("A ACTION");
        expect(A.fetcher.state).toBe("loading");
        expect(A.fetcher.data).toBe("A ACTION");

        await A.loaders.root.resolve("ROOT DATA");
        expect(A.fetcher.state).toBe("loading");
        expect(A.fetcher.data).toBe("A ACTION");

        await A.loaders.foo.resolve("A DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.data).toBe("A ACTION");
        expect(t.router.state.loaderData).toEqual({
          root: "ROOT DATA",
          foo: "A DATA",
        });
      });

      it("action re-fetch", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let key = "key";

        let A = await t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(A.fetcher.state).toBe("submitting");

        await A.actions.foo.resolve("A ACTION");
        expect(A.fetcher.state).toBe("loading");
        expect(A.fetcher.data).toBe("A ACTION");

        await A.loaders.root.resolve("ROOT DATA");
        await A.loaders.foo.resolve("A DATA");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.data).toBe("A ACTION");

        let B = await t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(B.fetcher.state).toBe("submitting");
        expect(B.fetcher.data).toBe("A ACTION");

        await B.actions.foo.resolve("B ACTION");
        await B.loaders.root.resolve("ROOT DATA*");
        await B.loaders.foo.resolve("A DATA*");
        expect(B.fetcher.state).toBe("idle");
        expect(B.fetcher.data).toBe("B ACTION");
      });
    });

    describe("fetcher removal", () => {
      it("gives an idle fetcher before submission", async () => {
        let t = initializeTmTest();
        let fetcher = t.router.getFetcher("randomKey");
        expect(fetcher).toBe(IDLE_FETCHER);
      });

      it("removes fetchers", async () => {
        let t = initializeTmTest();
        let A = await t.fetch("/foo");
        await A.loaders.foo.resolve("A");
        expect(t.router.getFetcher(A.key).data).toBe("A");

        t.router.deleteFetcher(A.key);
        expect(t.router.getFetcher(A.key)).toBe(IDLE_FETCHER);
      });

      it("cleans up abort controllers", async () => {
        let t = initializeTmTest();
        let A = await t.fetch("/foo");
        expect(t.router._internalFetchControllers.size).toBe(1);
        let B = await t.fetch("/bar");
        expect(t.router._internalFetchControllers.size).toBe(2);
        await A.loaders.foo.resolve(null);
        expect(t.router._internalFetchControllers.size).toBe(1);
        await B.loaders.bar.resolve(null);
        expect(t.router._internalFetchControllers.size).toBe(0);
      });

      it("uses current page matches and URL when reloading routes after submissions", async () => {
        let pagePathname = "/foo";
        let t = initializeTmTest({
          url: pagePathname,
          hydrationData: {
            loaderData: { root: "ROOT", foo: "FOO" },
          },
        });

        let A = await t.fetch("/bar", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        await A.actions.bar.resolve("ACTION");
        await A.loaders.root.resolve("ROOT DATA");
        await A.loaders.foo.resolve("FOO DATA");
        expect(t.router.state.loaderData).toEqual({
          root: "ROOT DATA",
          foo: "FOO DATA",
        });
        expect(A.loaders.root.stub).toHaveBeenCalledWith({
          params: {},
          request: new Request("http://localhost/foo", {
            signal: A.loaders.root.stub.mock.calls[0][0].request.signal,
          }),
        });
      });
    });

    describe("fetcher error states (4xx Response)", () => {
      it("loader fetch", async () => {
        let t = initializeTmTest();
        let A = await t.fetch("/foo");
        await A.loaders.foo.reject(new Response(null, { status: 400 }));
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          root: new ErrorResponse(400, undefined, ""),
        });
      });

      it("loader submission fetch", async () => {
        let t = initializeTmTest();
        let A = await t.fetch("/foo?key=value", {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        await A.loaders.foo.reject(new Response(null, { status: 400 }));
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          root: new ErrorResponse(400, undefined, ""),
        });
      });

      it("action fetch", async () => {
        let t = initializeTmTest();
        let A = await t.fetch("/foo", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        await A.actions.foo.reject(new Response(null, { status: 400 }));
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          root: new ErrorResponse(400, undefined, ""),
        });
      });

      it("action fetch without action handler", async () => {
        let t = setup({
          routes: [
            {
              id: "root",
              path: "/",
              hasErrorBoundary: true,
              children: [
                {
                  id: "index",
                  index: true,
                },
              ],
            },
          ],
        });
        let A = await t.fetch("/", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          root: new ErrorResponse(
            405,
            "Method Not Allowed",
            "No action found for [/]"
          ),
        });
      });

      it("handles fetcher errors at contextual route boundaries", async () => {
        let t = setup({
          routes: [
            {
              id: "root",
              path: "/",
              hasErrorBoundary: true,
              children: [
                {
                  id: "wit",
                  path: "wit",
                  loader: true,
                  hasErrorBoundary: true,
                },
                {
                  id: "witout",
                  path: "witout",
                  loader: true,
                },
                {
                  id: "error",
                  path: "error",
                  loader: true,
                },
              ],
            },
          ],
        });

        // If the routeId is not an active match, errors bubble to the root
        let A = await t.fetch("/error", "key1", "wit");
        await A.loaders.error.reject(new Error("Kaboom!"));
        expect(t.router.getFetcher("key1")).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          root: new Error("Kaboom!"),
        });

        await t.fetch("/not-found", "key2", "wit");
        expect(t.router.getFetcher("key2")).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          root: new ErrorResponse(404, "Not Found", null),
        });

        // Navigate to /wit and trigger errors, handled at the wit boundary
        let B = await t.navigate("/wit");
        await B.loaders.wit.resolve("WIT");

        let C = await t.fetch("/error", "key3", "wit");
        await C.loaders.error.reject(new Error("Kaboom!"));
        expect(t.router.getFetcher("key3")).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          wit: new Error("Kaboom!"),
        });

        await t.fetch("/not-found", "key4", "wit", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(t.router.getFetcher("key4")).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          wit: new ErrorResponse(404, "Not Found", null),
        });

        await t.fetch("/not-found", "key5", "wit");
        expect(t.router.getFetcher("key5")).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          wit: new ErrorResponse(404, "Not Found", null),
        });

        // Navigate to /witout and fetch a 404, handled at the root boundary
        let D = await t.navigate("/witout");
        await D.loaders.witout.resolve("WITOUT");

        let E = await t.fetch("/error", "key6", "witout");
        await E.loaders.error.reject(new Error("Kaboom!"));
        expect(t.router.getFetcher("key6")).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          root: new Error("Kaboom!"),
        });

        await t.fetch("/not-found", "key7", "witout");
        expect(t.router.getFetcher("key7")).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          root: new ErrorResponse(404, "Not Found", null),
        });
      });
    });

    describe("fetcher error states (Error)", () => {
      it("loader fetch", async () => {
        let t = initializeTmTest();
        let A = await t.fetch("/foo");
        await A.loaders.foo.reject(new Error("Kaboom!"));
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          root: new Error("Kaboom!"),
        });
      });

      it("loader submission fetch", async () => {
        let t = initializeTmTest();
        let A = await t.fetch("/foo?key=value", {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        await A.loaders.foo.reject(new Error("Kaboom!"));
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          root: new Error("Kaboom!"),
        });
      });

      it("action fetch", async () => {
        let t = initializeTmTest();
        let A = await t.fetch("/foo", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        await A.actions.foo.reject(new Error("Kaboom!"));
        expect(A.fetcher).toBe(IDLE_FETCHER);
        expect(t.router.state.errors).toEqual({
          root: new Error("Kaboom!"),
        });
      });
    });

    describe("fetcher redirects", () => {
      it("loader fetch", async () => {
        let t = initializeTmTest();
        let key = t.router.state.location.key;

        let A = await t.fetch("/foo");

        let B = await A.loaders.foo.redirect("/bar");
        expect(t.router.getFetcher(A.key)).toBe(A.fetcher);
        expect(t.router.state.navigation.state).toBe("loading");
        expect(t.router.state.navigation.location?.pathname).toBe("/bar");

        await B.loaders.bar.resolve("BAR");
        expect(t.router.state.navigation.state).toBe("idle");
        expect(t.router.state.historyAction).toBe("PUSH");
        expect(t.router.state.location?.pathname).toBe("/bar");

        // Back button should take us back to location that triggered the fetch
        // redirect
        let C = await t.navigate(-1);
        await C.loaders.index.resolve("INDEX");
        expect(t.router.state.location.pathname).toBe("/");
        expect(t.router.state.location.key).toBe(key);
      });

      it("loader submission fetch", async () => {
        let t = initializeTmTest();
        let key = t.router.state.location.key;
        let A = await t.fetch("/foo?key=value", {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });

        let B = await A.loaders.foo.redirect("/bar");
        expect(t.router.getFetcher(A.key)).toBe(A.fetcher);
        expect(t.router.state.navigation.state).toBe("loading");
        expect(t.router.state.navigation.location?.pathname).toBe("/bar");

        await B.loaders.bar.resolve("BAR");
        expect(t.router.state.navigation.state).toBe("idle");
        expect(t.router.state.historyAction).toBe("PUSH");
        expect(t.router.state.location?.pathname).toBe("/bar");

        // Back button should take us back to location that triggered the fetch
        // redirect
        let C = await t.navigate(-1);
        await C.loaders.index.resolve("INDEX");
        expect(t.router.state.location.pathname).toBe("/");
        expect(t.router.state.location.key).toBe(key);
      });

      it("action fetch", async () => {
        let t = initializeTmTest();
        let key = t.router.state.location.key;

        let A = await t.fetch("/foo", {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(A.fetcher.state).toBe("submitting");
        let AR = await A.actions.foo.redirect("/bar");
        expect(A.fetcher.state).toBe("loading");
        expect(t.router.state.navigation.state).toBe("loading");
        expect(t.router.state.navigation.location?.pathname).toBe("/bar");
        await AR.loaders.root.resolve("ROOT*");
        await AR.loaders.bar.resolve("stuff");
        expect(A.fetcher).toEqual({
          data: undefined,
          state: "idle",
          formMethod: undefined,
          formAction: undefined,
          formEncType: undefined,
          formData: undefined,
        });
        expect(t.router.state.historyAction).toBe("PUSH");
        expect(t.router.state.location.pathname).toBe("/bar");
        // Root loader should be re-called after fetchActionRedirect
        expect(t.router.state.loaderData).toEqual({
          root: "ROOT*",
          bar: "stuff",
        });

        // Back button should take us back to location that triggered the fetch
        // redirect
        let C = await t.navigate(-1);
        await C.loaders.index.resolve("INDEX");
        expect(t.router.state.location.pathname).toBe("/");
        expect(t.router.state.location.key).toBe(key);
      });
    });

    describe("fetcher resubmissions/re-gets", () => {
      it("aborts re-gets", async () => {
        let t = initializeTmTest();
        let key = "KEY";
        let A = await t.fetch("/foo", key);
        let B = await t.fetch("/foo", key);
        await A.loaders.foo.resolve(null);
        let C = await t.fetch("/foo", key);
        await B.loaders.foo.resolve(null);
        await C.loaders.foo.resolve(null);
        expect(A.loaders.foo.signal.aborted).toBe(true);
        expect(B.loaders.foo.signal.aborted).toBe(true);
        expect(C.loaders.foo.signal.aborted).toBe(false);
      });

      it("aborts re-get-submissions", async () => {
        let t = initializeTmTest();
        let key = "KEY";
        let A = await t.fetch("/foo", key, {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        let B = await t.fetch("/foo", key, {
          formMethod: "get",
          formData: createFormData({ key: "value" }),
        });
        let C = await t.fetch("/foo", key);
        expect(A.loaders.foo.signal.aborted).toBe(true);
        expect(B.loaders.foo.signal.aborted).toBe(true);
        await C.loaders.foo.resolve(null);
      });

      it("aborts resubmissions action call", async () => {
        let t = initializeTmTest();
        let key = "KEY";
        let A = await t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        let B = await t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        let C = await t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(A.actions.foo.signal.aborted).toBe(true);
        expect(B.actions.foo.signal.aborted).toBe(true);
        await C.actions.foo.resolve(null);
        await C.loaders.root.resolve(null);
        await C.loaders.index.resolve(null);
      });

      it("aborts resubmissions loader call", async () => {
        let t = initializeTmTest({ url: "/foo" });
        let key = "KEY";
        let A = await t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        await A.actions.foo.resolve("A ACTION");
        let C = await t.fetch("/foo", key, {
          formMethod: "post",
          formData: createFormData({ key: "value" }),
        });
        expect(A.loaders.foo.signal.aborted).toBe(true);
        await C.actions.foo.resolve(null);
        await C.loaders.root.resolve(null);
        await C.loaders.foo.resolve(null);
      });

      describe(`
        A) POST |--|--XXX
        B) POST       |----XXX|XXX
        C) POST            |----|---O
      `, () => {
        it("aborts A load, ignores A resolve, aborts B action", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let key = "KEY";

          let A = await t.fetch("/foo", key, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A ACTION");
          expect(t.router.getFetcher(key).data).toBe("A ACTION");

          let B = await t.fetch("/foo", key, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          expect(A.loaders.foo.signal.aborted).toBe(true);
          expect(t.router.getFetcher(key).data).toBe("A ACTION");

          await A.loaders.root.resolve("A ROOT LOADER");
          await A.loaders.foo.resolve("A LOADER");
          expect(t.router.state.loaderData.foo).toBeUndefined();

          let C = await t.fetch("/foo", key, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          expect(B.actions.foo.signal.aborted).toBe(true);

          await B.actions.foo.resolve("B ACTION");
          expect(t.router.getFetcher(key).data).toBe("A ACTION");

          await C.actions.foo.resolve("C ACTION");
          expect(t.router.getFetcher(key).data).toBe("C ACTION");

          await B.loaders.root.resolve("B ROOT LOADER");
          await B.loaders.foo.resolve("B LOADER");
          expect(t.router.state.loaderData.foo).toBeUndefined();

          await C.loaders.root.resolve("C ROOT LOADER");
          await C.loaders.foo.resolve("C LOADER");
          expect(t.router.getFetcher(key).data).toBe("C ACTION");
          expect(t.router.state.loaderData.foo).toBe("C LOADER");
        });
      });

      describe(`
        A) k1 |----|----X
        B) k2   |----|-----O
        C) k1           |-----|---O
      `, () => {
        it("aborts A load, commits B and C loads", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let k1 = "1";
          let k2 = "2";

          let Ak1 = await t.fetch("/foo", k1, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let Bk2 = await t.fetch("/foo", k2, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });

          await Ak1.actions.foo.resolve("A ACTION");
          await Bk2.actions.foo.resolve("B ACTION");
          expect(t.router.getFetcher(k2).data).toBe("B ACTION");

          let Ck1 = await t.fetch("/foo", k1, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          expect(Ak1.loaders.foo.signal.aborted).toBe(true);

          await Ak1.loaders.root.resolve("A ROOT LOADER");
          await Ak1.loaders.foo.resolve("A LOADER");
          expect(t.router.state.loaderData.foo).toBeUndefined();

          await Bk2.loaders.root.resolve("B ROOT LOADER");
          await Bk2.loaders.foo.resolve("B LOADER");
          expect(Ck1.actions.foo.signal.aborted).toBe(false);
          expect(t.router.state.loaderData.foo).toBe("B LOADER");

          await Ck1.actions.foo.resolve("C ACTION");
          await Ck1.loaders.root.resolve("C ROOT LOADER");
          await Ck1.loaders.foo.resolve("C LOADER");

          expect(t.router.getFetcher(k1).data).toBe("C ACTION");
          expect(t.router.state.loaderData.foo).toBe("C LOADER");
        });
      });
    });

    describe("multiple fetcher action reloads", () => {
      describe(`
        A) POST /foo |---[A]------O
        B) POST /foo   |-----[A,B]---O
      `, () => {
        it("commits A, commits B", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A action");
          await B.actions.foo.resolve("B action");

          await A.loaders.root.resolve("A root");
          await A.loaders.foo.resolve("A loader");
          expect(t.router.state.loaderData).toEqual({
            root: "A root",
            foo: "A loader",
          });

          await B.loaders.root.resolve("A,B root");
          await B.loaders.foo.resolve("A,B loader");
          expect(t.router.state.loaderData).toEqual({
            root: "A,B root",
            foo: "A,B loader",
          });
        });
      });

      describe(`
        A) POST /foo |----🧤
        B) POST /foo   |--X
      `, () => {
        it("catches A, persists boundary for B", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });

          await A.actions.foo.reject(new Response(null, { status: 400 }));
          expect(t.router.state.errors).toEqual({
            root: new ErrorResponse(400, undefined, ""),
          });

          await B.actions.foo.resolve("B");
          expect(t.router.state.errors).toEqual({
            root: new ErrorResponse(400, undefined, ""),
          });

          await B.loaders.root.resolve(null);
          await B.loaders.foo.resolve(null);
        });
      });

      describe(`
        A) POST /foo |----[A]-|
        B) POST /foo   |------🧤
      `, () => {
        it("commits A, catches B", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });

          await A.actions.foo.resolve("A action");
          await A.loaders.root.resolve("A root");
          await A.loaders.foo.resolve("A loader");
          expect(t.router.state.loaderData).toEqual({
            root: "A root",
            foo: "A loader",
          });

          await B.actions.foo.reject(new Response(null, { status: 400 }));
          expect(t.router.state.errors).toEqual({
            root: new ErrorResponse(400, undefined, ""),
          });
        });
      });

      describe(`
        A) POST /foo |---[A]-------X
        B) POST /foo   |----[A,B]--O
      `, () => {
        it("aborts A, commits B, sets A done", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A");
          await B.actions.foo.resolve("B");

          await B.loaders.root.resolve("A,B root");
          await B.loaders.foo.resolve("A,B");
          expect(t.router.state.loaderData).toEqual({
            root: "A,B root",
            foo: "A,B",
          });
          expect(A.loaders.foo.signal.aborted).toBe(true);
          expect(A.fetcher.state).toBe("idle");
          expect(A.fetcher.data).toBe("A");
        });
      });

      describe(`
        A) POST /foo |--------[B,A]---O
        B) POST /foo   |--[B]-------O
      `, () => {
        it("commits B, commits A", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });

          await B.actions.foo.resolve("B action");
          await A.actions.foo.resolve("A action");

          await B.loaders.root.resolve("B root");
          await B.loaders.foo.resolve("B");
          expect(t.router.state.loaderData).toEqual({
            root: "B root",
            foo: "B",
          });

          await A.loaders.root.resolve("B,A root");
          await A.loaders.foo.resolve("B,A");
          expect(t.router.state.loaderData).toEqual({
            root: "B,A root",
            foo: "B,A",
          });
        });
      });

      describe(`
        A) POST /foo |------|---O
        B) POST /foo   |--|-----X
      `, () => {
        it("aborts B, commits A, sets B done", async () => {
          let t = initializeTmTest({ url: "/foo" });

          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });

          await B.actions.foo.resolve("B");
          await A.actions.foo.resolve("A");

          await A.loaders.root.resolve("B,A root");
          await A.loaders.foo.resolve("B,A");
          expect(t.router.state.loaderData).toEqual({
            root: "B,A root",
            foo: "B,A",
          });
          expect(B.loaders.foo.signal.aborted).toBe(true);
          expect(B.fetcher.state).toBe("idle");
          expect(B.fetcher.data).toBe("B");
        });
      });
    });

    describe("navigating with inflight fetchers", () => {
      describe(`
        A) fetch POST |-------|--O
        B) nav GET      |---O
      `, () => {
        it("does not abort A action or data reload", async () => {
          let t = initializeTmTest({ url: "/foo" });

          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.navigate("/foo");
          expect(A.actions.foo.signal.aborted).toBe(false);
          expect(t.router.state.navigation.state).toBe("loading");
          expect(t.router.state.navigation.location?.pathname).toBe("/foo");

          await B.loaders.root.resolve("B root");
          await B.loaders.foo.resolve("B");
          expect(t.router.state.navigation.state).toBe("idle");
          expect(t.router.state.location.pathname).toBe("/foo");
          expect(t.router.state.loaderData.foo).toBe("B");
          expect(A.loaders.foo.signal).toBe(undefined); // A loaders not called yet

          await A.actions.foo.resolve("A root");
          await A.loaders.root.resolve("A root");
          await A.loaders.foo.resolve("A");
          expect(A.loaders.foo.signal.aborted).toBe(false);
          expect(t.router.state.loaderData).toEqual({
            root: "A root",
            foo: "A",
          });
        });
      });

      describe(`
        A) fetch POST |----|-----O
        B) nav GET      |-----O
      `, () => {
        it("Commits A and uses next matches", async () => {
          let t = initializeTmTest({ url: "/" });

          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          // This fetcher's helpers take the current locations loaders (root/index).
          // Since we know we're about to interrupt with /foo let's shim in a
          // loader helper for foo ahead of time
          t.shimHelper(A.loaders, "fetch", "loader", "foo");

          let B = await t.navigate("/foo");
          await A.actions.foo.resolve("A action");
          await B.loaders.root.resolve("B root");
          await B.loaders.foo.resolve("B");
          expect(A.actions.foo.signal.aborted).toBe(false);
          expect(A.loaders.foo.signal.aborted).toBe(false);
          expect(t.router.state.navigation.state).toBe("idle");
          expect(t.router.state.location.pathname).toBe("/foo");
          expect(t.router.state.loaderData.foo).toBe("B");

          await A.loaders.root.resolve("A root");
          await A.loaders.foo.resolve("A");
          expect(t.router.state.loaderData).toEqual({
            root: "A root",
            foo: "A",
          });
        });
      });

      describe(`
        A) fetch POST |--|----X
        B) nav GET         |--O
      `, () => {
        it("aborts A, sets fetcher done", async () => {
          let t = initializeTmTest({
            url: "/foo",
            hydrationData: { loaderData: { root: "ROOT", foo: "FOO" } },
          });

          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A");
          let B = await t.navigate("/foo");
          await B.loaders.root.resolve("ROOT*");
          await B.loaders.foo.resolve("B");
          expect(t.router.state.navigation.state).toBe("idle");
          expect(t.router.state.location.pathname).toBe("/foo");
          expect(t.router.state.loaderData).toEqual({
            root: "ROOT*",
            foo: "B",
          });
          expect(A.loaders.foo.signal.aborted).toBe(true);
          expect(A.fetcher.state).toBe("idle");
          expect(A.fetcher.data).toBe("A");
        });
      });

      describe(`
        A) fetch POST |--|---O
        B) nav GET         |---O
      `, () => {
        it("commits both", async () => {
          let t = initializeTmTest({ url: "/foo" });

          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A action");
          let B = await t.navigate("/foo");
          await A.loaders.root.resolve("A ROOT");
          await A.loaders.foo.resolve("A");
          expect(t.router.state.loaderData).toEqual({
            root: "A ROOT",
            foo: "A",
          });

          await B.loaders.root.resolve("B ROOT");
          await B.loaders.foo.resolve("B");
          expect(t.router.state.loaderData).toEqual({
            root: "B ROOT",
            foo: "B",
          });
        });
      });

      describe(`
        A) fetch POST |---[A]---O
        B) nav POST           |---[A,B]--O
      `, () => {
        it("keeps both", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A action");
          let B = await t.navigate("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.loaders.root.resolve("A ROOT");
          await A.loaders.foo.resolve("A");
          expect(t.router.state.loaderData).toEqual({
            root: "A ROOT",
            foo: "A",
          });

          await B.actions.foo.resolve("A,B");
          await B.loaders.root.resolve("A,B ROOT");
          await B.loaders.foo.resolve("A,B");
          expect(t.router.state.loaderData).toEqual({
            root: "A,B ROOT",
            foo: "A,B",
          });
        });
      });

      describe(`
        A) fetch POST |---[A]--------X
        B) nav POST     |-----[A,B]--O
      `, () => {
        it("aborts A, commits B, marks fetcher done", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          let B = await t.navigate("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A");
          await B.actions.foo.resolve("A,B");
          await B.loaders.root.resolve("A,B ROOT");
          await B.loaders.foo.resolve("A,B");
          expect(t.router.state.loaderData).toEqual({
            root: "A,B ROOT",
            foo: "A,B",
          });
          expect(A.loaders.foo.signal.aborted).toBe(true);
          expect(A.fetcher.state).toBe("idle");
          expect(A.fetcher.data).toBe("A");
        });
      });

      describe(`
        A) fetch POST |-----------[B,A]--O
        B) nav POST     |--[B]--O
      `, () => {
        it("commits both, uses the nav's href", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          t.shimHelper(A.loaders, "fetch", "loader", "bar");
          let B = await t.navigate("/bar", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await B.actions.bar.resolve("B");
          await B.loaders.root.resolve("B");
          await B.loaders.bar.resolve("B");
          await A.actions.foo.resolve("B,A");
          await A.loaders.root.resolve("B,A ROOT");
          await A.loaders.bar.resolve("B,A");
          expect(t.router.state.loaderData).toEqual({
            root: "B,A ROOT",
            bar: "B,A",
          });
        });
      });

      describe(`
        A) fetch POST |-------[B,A]--O
        B) nav POST     |--[B]-------X
      `, () => {
        it("aborts B, commits A, uses the nav's href", async () => {
          let t = initializeTmTest({ url: "/foo" });
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          t.shimHelper(A.loaders, "fetch", "loader", "bar");
          let B = await t.navigate("/bar", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await B.actions.bar.resolve("B");
          await A.actions.foo.resolve("B,A");
          await A.loaders.root.resolve("B,A ROOT");
          await A.loaders.bar.resolve("B,A");
          expect(B.loaders.bar.signal.aborted).toBe(true);
          expect(t.router.state.loaderData).toEqual({
            root: "B,A ROOT",
            bar: "B,A",
          });
          expect(t.router.state.navigation).toBe(IDLE_NAVIGATION);
        });
      });

      describe(`
        A) fetch POST /foo |--X
        B) nav   GET  /bar    |-----O
      `, () => {
        it("forces all loaders to revalidate on interrupted fetcher submission", async () => {
          let t = initializeTmTest();
          let A = await t.fetch("/foo", {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          t.shimHelper(A.loaders, "fetch", "loader", "bar");

          // Interrupting the submission should cause the next load to call all loaders
          let B = await t.navigate("/bar");
          await A.actions.foo.resolve("A ACTION");
          await B.loaders.root.resolve("ROOT*");
          await B.loaders.bar.resolve("BAR");
          expect(t.router.state).toMatchObject({
            navigation: IDLE_NAVIGATION,
            location: { pathname: "/bar" },
            actionData: null,
            loaderData: {
              root: "ROOT*",
              bar: "BAR",
            },
          });

          await A.loaders.root.resolve("ROOT**");
          await A.loaders.bar.resolve("BAR*");
          expect(t.router.state).toMatchObject({
            navigation: IDLE_NAVIGATION,
            location: { pathname: "/bar" },
            actionData: null,
            loaderData: {
              root: "ROOT**",
              bar: "BAR*",
            },
          });
        });
      });

      describe(`
        A) fetch POST /foo |--|--X
        B) nav   GET  /bar       |-----O
      `, () => {
        it("forces all loaders to revalidate on interrupted fetcher actionReload", async () => {
          let key = "key";
          let t = initializeTmTest();
          let A = await t.fetch("/foo", key, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.resolve("A ACTION");
          expect(t.router.state.fetchers.get(key)?.state).toBe("loading");
          expect(t.router.state.fetchers.get(key)?.data).toBe("A ACTION");
          // Interrupting the actionReload should cause the next load to call all loaders
          let B = await t.navigate("/bar");
          await B.loaders.root.resolve("ROOT*");
          await B.loaders.bar.resolve("BAR");
          expect(t.router.state).toMatchObject({
            navigation: IDLE_NAVIGATION,
            location: { pathname: "/bar" },
            actionData: null,
            loaderData: {
              root: "ROOT*",
              bar: "BAR",
            },
          });
          expect(t.router.state.fetchers.get(key)?.state).toBe("idle");
          expect(t.router.state.fetchers.get(key)?.data).toBe("A ACTION");
        });

        it("forces all loaders to revalidate on interrupted fetcher submissionRedirect", async () => {
          let key = "key";
          let t = initializeTmTest();
          let A = await t.fetch("/foo", key, {
            formMethod: "post",
            formData: createFormData({ key: "value" }),
          });
          await A.actions.foo.redirect("/baz");
          expect(t.router.state.fetchers.get(key)?.state).toBe("loading");
          // Interrupting the actionReload should cause the next load to call all loaders
          let B = await t.navigate("/bar");
          await B.loaders.root.resolve("ROOT*");
          await B.loaders.bar.resolve("BAR");
          expect(t.router.state).toMatchObject({
            navigation: IDLE_NAVIGATION,
            location: { pathname: "/bar" },
            loaderData: {
              root: "ROOT*",
              bar: "BAR",
            },
          });
          expect(t.router.state.fetchers.get(key)?.state).toBe("idle");
          expect(t.router.state.fetchers.get(key)?.data).toBeUndefined();
        });
      });
    });

    describe("fetcher revalidation", () => {
      it("revalidates fetchers on action submissions", async () => {
        let t = setup({
          routes: TASK_ROUTES,
          initialEntries: ["/"],
          hydrationData: { loaderData: { root: "ROOT", index: "INDEX" } },
        });
        expect(t.router.state.navigation).toBe(IDLE_NAVIGATION);

        let key1 = "key1";
        let A = await t.fetch("/tasks/1", key1);
        await A.loaders.tasksId.resolve("TASKS 1");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.data).toBe("TASKS 1");

        let C = await t.navigate("/tasks", {
          formMethod: "post",
          formData: createFormData({}),
        });
        // Add a helper for the fetcher that will be revalidating
        t.shimHelper(C.loaders, "navigation", "loader", "tasksId");

        // Resolve the action
        await C.actions.tasks.resolve("TASKS ACTION");

        // Fetcher should go back into a loading state
        expect(t.router.state.fetchers.get(key1)?.state).toBe("loading");

        // Resolve navigation loaders + fetcher loader
        await C.loaders.root.resolve("ROOT*");
        await C.loaders.tasks.resolve("TASKS LOADER");
        await C.loaders.tasksId.resolve("TASKS ID*");
        expect(t.router.state.fetchers.get(key1)).toMatchObject({
          state: "idle",
          data: "TASKS ID*",
        });

        // If a fetcher does a submission, it unsets the revalidation aspect
        let D = await t.fetch("/tasks/3", key1, {
          formMethod: "post",
          formData: createFormData({}),
        });
        await D.actions.tasksId.resolve("TASKS 3");
        await D.loaders.root.resolve("ROOT**");
        await D.loaders.tasks.resolve("TASKS**");
        expect(t.router.state.fetchers.get(key1)).toMatchObject({
          state: "idle",
          data: "TASKS 3",
        });

        let E = await t.navigate("/tasks", {
          formMethod: "post",
          formData: createFormData({}),
        });
        await E.actions.tasks.resolve("TASKS ACTION");
        await E.loaders.root.resolve("ROOT***");
        await E.actions.tasks.resolve("TASKS***");

        // Remains the same state as it was after the submission
        expect(t.router.state.fetchers.get(key1)).toMatchObject({
          state: "idle",
          data: "TASKS 3",
        });
      });

      it("revalidates fetchers on action redirects", async () => {
        let t = setup({
          routes: TASK_ROUTES,
          initialEntries: ["/"],
          hydrationData: { loaderData: { root: "ROOT", index: "INDEX" } },
        });
        expect(t.router.state.navigation).toBe(IDLE_NAVIGATION);

        let key = "key";
        let A = await t.fetch("/tasks/1", key);
        await A.loaders.tasksId.resolve("TASKS ID");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.data).toBe("TASKS ID");

        let C = await t.navigate("/tasks", {
          formMethod: "post",
          formData: createFormData({}),
        });

        // Redirect the action
        let D = await C.actions.tasks.redirect("/", undefined, undefined, [
          "tasksId",
        ]);
        expect(t.router.state.fetchers.get(key)?.state).toBe("loading");

        // Resolve navigation loaders + fetcher loader
        await D.loaders.root.resolve("ROOT*");
        await D.loaders.index.resolve("INDEX*");
        await D.loaders.tasksId.resolve("TASKS ID*");
        expect(t.router.state.fetchers.get(key)).toMatchObject({
          state: "idle",
          data: "TASKS ID*",
        });
      });

      it("revalidates fetchers on action errors", async () => {
        let t = setup({
          routes: TASK_ROUTES,
          initialEntries: ["/"],
          hydrationData: { loaderData: { root: "ROOT", index: "INDEX" } },
        });
        expect(t.router.state.navigation).toBe(IDLE_NAVIGATION);

        let key = "key";
        let A = await t.fetch("/tasks/1", key);
        await A.loaders.tasksId.resolve("TASKS ID");
        expect(A.fetcher.state).toBe("idle");
        expect(A.fetcher.data).toBe("TASKS ID");

        let C = await t.navigate("/tasks", {
          formMethod: "post",
          formData: createFormData({}),
        });
        t.shimHelper(C.loaders, "navigation", "loader", "tasksId");

        // Reject the action
        await C.actions.tasks.reject(new Error("Kaboom!"));
        expect(t.router.state.fetchers.get(key)?.state).toBe("loading");

        // Resolve navigation loaders + fetcher loader
        await C.loaders.root.resolve("ROOT*");
        await C.loaders.tasksId.resolve("TASKS ID*");
        expect(t.router.state.fetchers.get(key)).toMatchObject({
          state: "idle",
          data: "TASKS ID*",
        });
      });

      it("does not revalidate idle fetchers when a loader navigation is performed", async () => {
        let key = "key";
        let t = setup({
          routes: TASK_ROUTES,
          initialEntries: ["/"],
          hydrationData: { loaderData: { root: "ROOT", index: "INDEX" } },
        });

        let A = await t.fetch("/", key);
        await A.loaders.root.resolve("ROOT FETCH");
        expect(t.router.state.fetchers.get(key)).toMatchObject({
          state: "idle",
          data: "ROOT FETCH",
        });

        let B = await t.navigate("/tasks");
        await B.loaders.tasks.resolve("TASKS");
        expect(t.router.state.loaderData).toMatchObject({
          root: "ROOT",
          tasks: "TASKS",
        });
        expect(t.router.state.fetchers.get(key)).toMatchObject({
          state: "idle",
          data: "ROOT FETCH",
        });
      });

      it("respects shouldRevalidate for the fetcher route", async () => {
        let key = "key";
        let count = 0;
        let shouldRevalidate = jest.fn((args) => false);
        let router = createRouter({
          history: createMemoryHistory({ initialEntries: ["/"] }),
          routes: [
            {
              id: "root",
              path: "/",
              loader: () => Promise.resolve(++count),
              action: () => Promise.resolve(null),
            },
            {
              id: "fetch",
              path: "/fetch",
              loader: () => Promise.resolve(++count),
              shouldRevalidate,
            },
          ],
          hydrationData: {
            loaderData: { root: count },
          },
        });

        expect(router.state.loaderData).toMatchObject({
          root: 0,
        });
        expect(router.getFetcher(key)).toBe(IDLE_FETCHER);

        // Fetch from a different route
        router.fetch(key, "root", "/fetch");
        await tick();
        expect(router.getFetcher(key)).toMatchObject({
          state: "idle",
          data: 1,
        });

        // Post to the current route
        router.navigate("/", {
          formMethod: "post",
          formData: createFormData({}),
        });
        await tick();
        expect(router.state.loaderData).toMatchObject({
          root: 2,
        });
        expect(router.getFetcher(key)).toMatchObject({
          state: "idle",
          data: 1,
        });
        expect(shouldRevalidate.mock.calls[0][0]).toMatchInlineSnapshot(`
          Object {
            "actionResult": null,
            "currentParams": Object {},
            "currentUrl": "http://localhost/fetch",
            "defaultShouldRevalidate": true,
            "formAction": "/",
            "formData": FormData {},
            "formEncType": "application/x-www-form-urlencoded",
            "formMethod": "post",
            "nextParams": Object {},
            "nextUrl": "http://localhost/fetch",
          }
        `);

        expect(router._internalFetchControllers.size).toBe(0);
        router.dispose();
      });

      it("handles fetcher revalidation errors", async () => {
        let key = "key";
        let t = setup({
          routes: TASK_ROUTES,
          initialEntries: ["/"],
          hydrationData: { loaderData: { root: "ROOT", index: "INDEX" } },
        });

        expect(t.router.state).toMatchObject({
          loaderData: {
            root: "ROOT",
            index: "INDEX",
          },
          errors: null,
        });

        let A = await t.fetch("/tasks/1", key);
        await A.loaders.tasksId.resolve("ROOT FETCH");
        expect(t.router.state.fetchers.get(key)).toMatchObject({
          state: "idle",
          data: "ROOT FETCH",
        });

        let B = await t.navigate("/tasks", {
          formMethod: "post",
          formData: createFormData({}),
        });
        t.shimHelper(B.loaders, "navigation", "loader", "tasksId");
        await B.actions.tasks.resolve("TASKS ACTION");
        await B.loaders.root.resolve("ROOT*");
        await B.loaders.tasks.resolve("TASKS*");
        await B.loaders.tasksId.reject(new Error("Fetcher error"));
        expect(t.router.state).toMatchObject({
          loaderData: {
            root: "ROOT*",
            tasks: "TASKS*",
          },
          errors: {
            // Even though tasksId has an error boundary, this bubbles up to
            // the root since it's the closest "active" rendered route with an
            // error boundary
            root: new Error("Fetcher error"),
          },
        });
        expect(t.router.state.fetchers.get(key)).toBe(undefined);
      });

      it("revalidates fetchers on fetcher action submissions", async () => {
        let key = "key";
        let actionKey = "actionKey";
        let t = setup({
          routes: TASK_ROUTES,
          initialEntries: ["/"],
          hydrationData: { loaderData: { root: "ROOT", index: "INDEX" } },
        });

        // Load a fetcher
        let A = await t.fetch("/tasks/1", key);
        await A.loaders.tasksId.resolve("TASKS ID");
        expect(t.router.state.fetchers.get(key)).toMatchObject({
          state: "idle",
          data: "TASKS ID",
        });

        // Submit a fetcher, leaves loaded fetcher untouched
        let C = await t.fetch("/tasks", actionKey, {
          formMethod: "post",
          formData: createFormData({}),
        });
        t.shimHelper(C.loaders, "fetch", "loader", "tasksId");
        expect(t.router.state.fetchers.get(key)).toMatchObject({
          state: "idle",
          data: "TASKS ID",
        });
        expect(t.router.state.fetchers.get(actionKey)).toMatchObject({
          state: "submitting",
        });

        // After acton resolves, both fetchers go into a loading state, with
        // the load fetcher still reflecting it's stale data
        await C.actions.tasks.resolve("TASKS ACTION");
        expect(t.router.state.fetchers.get(key)).toMatchObject({
          state: "loading",
          data: "TASKS ID",
        });
        expect(t.router.state.fetchers.get(actionKey)).toMatchObject({
          state: "loading",
          data: "TASKS ACTION",
        });

        // All go back to idle on resolutions
        await C.loaders.root.resolve("ROOT*");
        await C.loaders.index.resolve("INDEX*");
        await C.loaders.tasksId.resolve("TASKS ID*");

        expect(t.router.state.loaderData).toMatchObject({
          root: "ROOT*",
          index: "INDEX*",
        });
        expect(t.router.state.fetchers.get(key)).toMatchObject({
          state: "idle",
          data: "TASKS ID*",
        });
        expect(t.router.state.fetchers.get(actionKey)).toMatchObject({
          state: "idle",
          data: "TASKS ACTION",
        });
      });

      it("cancels in-flight fetcher.loads on action submission and forces reload", async () => {
        let t = setup({
          routes: [
            {
              id: "index",
              index: true,
            },
            {
              id: "action",
              path: "action",
              action: true,
            },
            // fetch A will resolve before the action and will be able to opt-out
            {
              id: "fetchA",
              path: "fetch-a",
              loader: true,
              shouldRevalidate: () => false,
            },
            // fetch B will resolve before the action but then issue a second
            // load that gets cancelled.  It will not be able to opt out because
            // of the cancellation
            {
              id: "fetchB",
              path: "fetch-b",
              loader: true,
              shouldRevalidate: () => false,
            },
            // fetch C will not before the action, and will not be able to opt
            // out because it has no data
            {
              id: "fetchC",
              path: "fetch-c",
              loader: true,
              shouldRevalidate: () => false,
            },
          ],
          initialEntries: ["/"],
          hydrationData: { loaderData: { index: "INDEX" } },
        });
        expect(t.router.state.navigation).toBe(IDLE_NAVIGATION);

        let keyA = "a";
        let A = await t.fetch("/fetch-a", keyA);
        await A.loaders.fetchA.resolve("A");
        expect(t.router.state.fetchers.get(keyA)).toMatchObject({
          state: "idle",
          data: "A",
        });

        let keyB = "b";
        let B = await t.fetch("/fetch-b", keyB);
        await B.loaders.fetchB.resolve("B");
        expect(t.router.state.fetchers.get(keyB)).toMatchObject({
          state: "idle",
          data: "B",
        });

        // Fetch again for B
        let B2 = await t.fetch("/fetch-b", keyB);
        expect(t.router.state.fetchers.get(keyB)?.state).toBe("loading");

        // Start another fetcher which will not resolve prior to the action
        let keyC = "c";
        let C = await t.fetch("/fetch-c", keyC);
        expect(t.router.state.fetchers.get(keyC)?.state).toBe("loading");

        // Navigation should cancel fetcher and since it has no data
        // shouldRevalidate should be ignored on subsequent fetch
        let D = await t.navigate("/action", {
          formMethod: "post",
          formData: createFormData({}),
        });
        // Add a helper for the fetcher that will be revalidating
        t.shimHelper(D.loaders, "navigation", "loader", "fetchA");
        t.shimHelper(D.loaders, "navigation", "loader", "fetchB");
        t.shimHelper(D.loaders, "navigation", "loader", "fetchC");

        // Fetcher load aborted and still in a loading state
        expect(t.router.state.navigation.state).toBe("submitting");
        expect(A.loaders.fetchA.signal.aborted).toBe(false);
        expect(B.loaders.fetchB.signal.aborted).toBe(false);
        expect(B2.loaders.fetchB.signal.aborted).toBe(true);
        expect(C.loaders.fetchC.signal.aborted).toBe(true);
        expect(t.router.state.fetchers.get(keyA)?.state).toBe("idle");
        expect(t.router.state.fetchers.get(keyB)?.state).toBe("loading");
        expect(t.router.state.fetchers.get(keyC)?.state).toBe("loading");
        await B.loaders.fetchB.resolve("B"); // ignored due to abort
        await C.loaders.fetchC.resolve("C"); // ignored due to abort

        // Resolve the action
        await D.actions.action.resolve("ACTION");
        expect(t.router.state.navigation.state).toBe("loading");
        expect(t.router.state.fetchers.get(keyA)?.state).toBe("idle");
        expect(t.router.state.fetchers.get(keyB)?.state).toBe("loading");
        expect(t.router.state.fetchers.get(keyC)?.state).toBe("loading");

        // Resolve fetcher loader
        await D.loaders.fetchB.resolve("B2");
        await D.loaders.fetchC.resolve("C");
        expect(t.router.state.navigation.state).toBe("idle");
        expect(t.router.state.fetchers.get(keyA)).toMatchObject({
          state: "idle",
          data: "A",
        });
        expect(t.router.state.fetchers.get(keyB)).toMatchObject({
          state: "idle",
          data: "B2",
        });
        expect(t.router.state.fetchers.get(keyC)).toMatchObject({
          state: "idle",
          data: "C",
        });
      });
    });
  });

  describe("deferred data", () => {
    it("should not track deferred responses on naked objects", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
          },
          {
            id: "lazy",
            path: "lazy",
            loader: true,
          },
        ],
        initialEntries: ["/"],
      });

      let A = await t.navigate("/lazy");

      let dfd = createDeferred();
      await A.loaders.lazy.resolve({
        critical: "1",
        lazy: dfd.promise,
      });
      expect(t.router.state.loaderData).toEqual({
        lazy: {
          critical: "1",
          lazy: expect.any(Promise),
        },
      });
      expect(t.router.state.loaderData.lazy.lazy._tracked).toBeUndefined();
    });

    it("should support returning deferred responses", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
          },
          {
            id: "lazy",
            path: "lazy",
            loader: true,
          },
        ],
        initialEntries: ["/"],
      });

      let A = await t.navigate("/lazy");

      let dfd1 = createDeferred();
      let dfd2 = createDeferred();
      let dfd3 = createDeferred();
      dfd1.resolve("Immediate data");
      await A.loaders.lazy.resolve(
        defer({
          critical1: "1",
          critical2: "2",
          lazy1: dfd1.promise,
          lazy2: dfd2.promise,
          lazy3: dfd3.promise,
        })
      );
      expect(t.router.state.loaderData).toEqual({
        lazy: {
          critical1: "1",
          critical2: "2",
          lazy1: expect.trackedPromise("Immediate data"),
          lazy2: expect.trackedPromise(),
          lazy3: expect.trackedPromise(),
        },
      });

      await dfd2.resolve("2");
      expect(t.router.state.loaderData).toEqual({
        lazy: {
          critical1: "1",
          critical2: "2",
          lazy1: expect.trackedPromise("Immediate data"),
          lazy2: expect.trackedPromise("2"),
          lazy3: expect.trackedPromise(),
        },
      });

      await dfd3.resolve("3");
      expect(t.router.state.loaderData).toEqual({
        lazy: {
          critical1: "1",
          critical2: "2",
          lazy1: expect.trackedPromise("Immediate data"),
          lazy2: expect.trackedPromise("2"),
          lazy3: expect.trackedPromise("3"),
        },
      });

      // Should proxy values through
      let data = t.router.state.loaderData.lazy;
      await expect(data.lazy1).resolves.toBe("Immediate data");
      await expect(data.lazy2).resolves.toBe("2");
      await expect(data.lazy3).resolves.toBe("3");
    });

    it("should cancel outstanding deferreds on a new navigation", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
            loader: true,
          },
          {
            id: "lazy",
            path: "lazy",
            loader: true,
          },
        ],
        hydrationData: { loaderData: { index: "INDEX" } },
        initialEntries: ["/"],
      });

      let A = await t.navigate("/lazy");
      let dfd1 = createDeferred();
      let dfd2 = createDeferred();
      await A.loaders.lazy.resolve(
        defer({
          critical1: "1",
          critical2: "2",
          lazy1: dfd1.promise,
          lazy2: dfd2.promise,
        })
      );

      // Interrupt pending deferred's from /lazy navigation
      let navPromise = t.navigate("/");

      // Cancelled promises should reject immediately
      let data = t.router.state.loaderData.lazy;
      await expect(data.lazy1).rejects.toBeInstanceOf(AbortedDeferredError);
      await expect(data.lazy2).rejects.toBeInstanceOf(AbortedDeferredError);
      await expect(data.lazy1).rejects.toThrowError("Deferred data aborted");
      await expect(data.lazy2).rejects.toThrowError("Deferred data aborted");

      let B = await navPromise;

      // During navigation - deferreds remain as promises
      expect(t.router.state.loaderData).toEqual({
        lazy: {
          critical1: "1",
          critical2: "2",
          lazy1: expect.trackedPromise(null, null, true),
          lazy2: expect.trackedPromise(null, null, true),
        },
      });

      // But they are frozen - no re-paints on resolve/reject!
      await dfd1.resolve("a");
      await dfd2.reject(new Error("b"));
      expect(t.router.state.loaderData).toEqual({
        lazy: {
          critical1: "1",
          critical2: "2",
          lazy1: expect.trackedPromise(null, null, true),
          lazy2: expect.trackedPromise(null, null, true),
        },
      });

      await B.loaders.index.resolve("INDEX*");
      expect(t.router.state.loaderData).toEqual({
        index: "INDEX*",
      });
    });

    it("should not cancel outstanding deferreds on reused routes", async () => {
      let t = setup({
        routes: [
          {
            id: "root",
            path: "/",
            loader: true,
          },
          {
            id: "parent",
            path: "parent",
            loader: true,
            children: [
              {
                id: "a",
                path: "a",
                loader: true,
              },
              {
                id: "b",
                path: "b",
                loader: true,
              },
            ],
          },
        ],
        hydrationData: { loaderData: { root: "ROOT" } },
        initialEntries: ["/"],
      });

      let A = await t.navigate("/parent/a");
      let parentDfd = createDeferred();
      await A.loaders.parent.resolve(
        defer({
          critical: "CRITICAL PARENT",
          lazy: parentDfd.promise,
        })
      );
      let aDfd = createDeferred();
      await A.loaders.a.resolve(
        defer({
          critical: "CRITICAL A",
          lazy: aDfd.promise,
        })
      );

      // Navigate such that we reuse the parent route
      let B = await t.navigate("/parent/b");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(),
        },
        a: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(),
        },
      });

      // This should reflect in loaderData
      await parentDfd.resolve("LAZY PARENT");
      // This should not
      await aDfd.resolve("LAZY A");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise("LAZY PARENT"),
        },
        a: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(null, null, true), // No re-paint!
        },
      });

      // Complete the navigation
      await B.loaders.b.resolve("B DATA");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise("LAZY PARENT"),
        },
        b: "B DATA",
      });
    });

    it("should handle promise rejections", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
          },
          {
            id: "lazy",
            path: "lazy",
            loader: true,
          },
        ],
        initialEntries: ["/"],
      });

      let A = await t.navigate("/lazy");

      let dfd = createDeferred();
      await A.loaders.lazy.resolve(
        defer({
          critical: "1",
          lazy: dfd.promise,
        })
      );

      await dfd.reject(new Error("Kaboom!"));
      expect(t.router.state.loaderData).toEqual({
        lazy: {
          critical: "1",
          lazy: expect.trackedPromise(undefined, new Error("Kaboom!")),
        },
      });

      // should proxy the error through
      let data = t.router.state.loaderData.lazy;
      await expect(data.lazy).rejects.toEqual(new Error("Kaboom!"));
    });

    it("should cancel all outstanding deferreds on router.revalidate()", async () => {
      let shouldRevalidateSpy = jest.fn(() => false);
      let t = setup({
        routes: [
          {
            id: "root",
            path: "/",
            loader: true,
          },
          {
            id: "parent",
            path: "parent",
            loader: true,
            shouldRevalidate: shouldRevalidateSpy,
            children: [
              {
                id: "index",
                index: true,
                loader: true,
              },
            ],
          },
        ],
        hydrationData: { loaderData: { root: "ROOT" } },
        initialEntries: ["/"],
      });

      let A = await t.navigate("/parent");
      let parentDfd = createDeferred();
      await A.loaders.parent.resolve(
        defer({
          critical: "CRITICAL PARENT",
          lazy: parentDfd.promise,
        })
      );
      let indexDfd = createDeferred();
      await A.loaders.index.resolve(
        defer({
          critical: "CRITICAL INDEX",
          lazy: indexDfd.promise,
        })
      );

      // Trigger a revalidation which should cancel outstanding deferreds
      let R = await t.revalidate();
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(),
        },
        index: {
          critical: "CRITICAL INDEX",
          lazy: expect.trackedPromise(),
        },
      });

      // Neither should reflect in loaderData
      await parentDfd.resolve("Nope!");
      await indexDfd.resolve("Nope!");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(null, null, true),
        },
        index: {
          critical: "CRITICAL INDEX",
          lazy: expect.trackedPromise(null, null, true),
        },
      });

      // Complete the revalidation
      let parentDfd2 = createDeferred();
      await R.loaders.parent.resolve(
        defer({
          critical: "CRITICAL PARENT 2",
          lazy: parentDfd2.promise,
        })
      );
      let indexDfd2 = createDeferred();
      await R.loaders.index.resolve(
        defer({
          critical: "CRITICAL INDEX 2",
          lazy: indexDfd2.promise,
        })
      );

      // Revalidations await all deferreds, so we're still in a loading
      // state with the prior loaderData here
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.revalidation).toBe("loading");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(null, null, true),
        },
        index: {
          critical: "CRITICAL INDEX",
          lazy: expect.trackedPromise(null, null, true),
        },
      });

      await indexDfd2.resolve("LAZY INDEX 2");
      // Not done yet!
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.revalidation).toBe("loading");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(null, null, true),
        },
        index: {
          critical: "CRITICAL INDEX",
          lazy: expect.trackedPromise(null, null, true),
        },
      });

      await parentDfd2.resolve("LAZY PARENT 2");
      // Done now that all deferreds have resolved
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.revalidation).toBe("idle");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT 2",
          lazy: expect.trackedPromise("LAZY PARENT 2"),
        },
        index: {
          critical: "CRITICAL INDEX 2",
          lazy: expect.trackedPromise("LAZY INDEX 2"),
        },
      });

      expect(shouldRevalidateSpy).not.toHaveBeenCalled();
    });

    it("cancels correctly on revalidations chains", async () => {
      let shouldRevalidateSpy = jest.fn(() => false);
      let t = setup({
        routes: [
          {
            id: "root",
            path: "/",
          },
          {
            id: "foo",
            path: "foo",
            loader: true,
            shouldRevalidate: shouldRevalidateSpy,
          },
        ],
      });

      let A = await t.navigate("/foo");
      let dfda = createDeferred();
      await A.loaders.foo.resolve(
        defer({
          critical: "CRITICAL A",
          lazy: dfda.promise,
        })
      );
      expect(t.router.state.loaderData).toEqual({
        foo: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(),
        },
      });

      let B = await t.revalidate();
      let dfdb = createDeferred();
      // This B data will _never_ make it through - since we will await all of
      // it and we'll revalidate before it resolves
      await B.loaders.foo.resolve(
        defer({
          critical: "CRITICAL B",
          lazy: dfdb.promise,
        })
      );
      // The initial revalidation cancelled the navigation deferred
      await dfda.resolve("Nope!");
      expect(t.router.state.loaderData).toEqual({
        foo: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(null, null, true),
        },
      });

      let C = await t.revalidate();
      let dfdc = createDeferred();
      await C.loaders.foo.resolve(
        defer({
          critical: "CRITICAL C",
          lazy: dfdc.promise,
        })
      );
      // The second revalidation should have cancelled the first revalidation
      // deferred
      await dfdb.resolve("Nope!");
      expect(t.router.state.loaderData).toEqual({
        foo: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(null, null, true),
        },
      });

      // Resolve the final revalidation which should make it into loaderData
      await dfdc.resolve("Yep!");
      expect(t.router.state.loaderData).toEqual({
        foo: {
          critical: "CRITICAL C",
          lazy: expect.trackedPromise("Yep!"),
        },
      });

      expect(shouldRevalidateSpy).not.toHaveBeenCalled();
    });

    it("cancels correctly on revalidations interrupted by navigations", async () => {
      let t = setup({
        routes: [
          {
            id: "root",
            path: "/",
          },
          {
            id: "foo",
            path: "foo",
            loader: true,
          },
          {
            id: "bar",
            path: "bar",
            loader: true,
          },
        ],
      });

      let A = await t.navigate("/foo");
      let dfda = createDeferred();
      await A.loaders.foo.resolve(
        defer({
          critical: "CRITICAL A",
          lazy: dfda.promise,
        })
      );
      await dfda.resolve("LAZY A");
      expect(t.router.state.loaderData).toEqual({
        foo: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise("LAZY A"),
        },
      });

      let B = await t.revalidate();
      let dfdb = createDeferred();
      await B.loaders.foo.resolve(
        defer({
          critical: "CRITICAL B",
          lazy: dfdb.promise,
        })
      );
      // B not reflected because its got existing loaderData
      expect(t.router.state.loaderData).toEqual({
        foo: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise("LAZY A"),
        },
      });

      let C = await t.navigate("/bar");
      let dfdc = createDeferred();
      await C.loaders.bar.resolve(
        defer({
          critical: "CRITICAL C",
          lazy: dfdc.promise,
        })
      );
      // The second revalidation should have cancelled the first revalidation
      // deferred
      await dfdb.resolve("Nope!");
      expect(t.router.state.loaderData).toEqual({
        bar: {
          critical: "CRITICAL C",
          lazy: expect.trackedPromise(),
        },
      });

      await dfdc.resolve("Yep!");
      expect(t.router.state.loaderData).toEqual({
        bar: {
          critical: "CRITICAL C",
          lazy: expect.trackedPromise("Yep!"),
        },
      });
    });

    it("cancels pending deferreds on 404 navigations", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
            loader: true,
          },
          {
            id: "lazy",
            path: "lazy",
            loader: true,
          },
        ],
        hydrationData: { loaderData: { index: "INDEX" } },
        initialEntries: ["/"],
      });

      let A = await t.navigate("/lazy");
      let dfd = createDeferred();
      await A.loaders.lazy.resolve(
        defer({
          critical: "CRITICAL",
          lazy: dfd.promise,
        })
      );

      await t.navigate("/not-found");
      // Navigation completes immediately and deferreds are cancelled
      expect(t.router.state.loaderData).toEqual({});

      // Resolution doesn't do anything
      await dfd.resolve("Nope!");
      expect(t.router.state.loaderData).toEqual({});
    });

    it("cancels pending deferreds on errored GET submissions (w/ reused routes)", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
            loader: true,
          },
          {
            id: "parent",
            path: "parent",
            loader: true,
            hasErrorBoundary: true,
            children: [
              {
                id: "a",
                path: "a",
                loader: true,
              },
              {
                id: "b",
                path: "b",
              },
            ],
          },
        ],
        hydrationData: { loaderData: { index: "INDEX" } },
        initialEntries: ["/"],
      });

      // Navigate to /parent/a and kick off a deferred's for both
      let A = await t.navigate("/parent/a");
      let parentDfd = createDeferred();
      await A.loaders.parent.resolve(
        defer({
          critical: "CRITICAL PARENT",
          lazy: parentDfd.promise,
        })
      );
      let aDfd = createDeferred();
      await A.loaders.a.resolve(
        defer({
          critical: "CRITICAL A",
          lazy: aDfd.promise,
        })
      );
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(),
        },
        a: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(),
        },
      });

      // Perform an invalid navigation to /parent/b which will be handled
      // using parent's error boundary.  Parent's deferred should be left alone
      // while A's should be cancelled since they will no longer be rendered
      let formData = new FormData();
      formData.append("file", new Blob(["1", "2"]), "file.txt");
      await t.navigate("/parent/b", {
        formMethod: "get",
        formData,
      });
      // Navigation completes immediately with an error at the boundary
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(),
        },
      });
      expect(t.router.state.errors).toEqual({
        parent: new ErrorResponse(
          400,
          "Bad Request",
          "Cannot submit binary form data using GET"
        ),
      });

      await parentDfd.resolve("Yep!");
      await aDfd.resolve("Nope!");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise("Yep!"),
        },
      });
    });

    it("cancels pending deferreds on errored GET submissions (w/o reused routes)", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
            loader: true,
          },
          {
            id: "a",
            path: "a",
            loader: true,
            children: [
              {
                id: "aChild",
                path: "child",
                loader: true,
              },
            ],
          },
          {
            id: "b",
            path: "b",
            loader: true,
            children: [
              {
                id: "bChild",
                path: "child",
                loader: true,
                hasErrorBoundary: true,
              },
            ],
          },
        ],
        hydrationData: { loaderData: { index: "INDEX" } },
        initialEntries: ["/"],
      });

      // Navigate to /parent/a and kick off deferred's for both
      let A = await t.navigate("/a/child");
      let aDfd = createDeferred();
      await A.loaders.a.resolve(
        defer({
          critical: "CRITICAL A",
          lazy: aDfd.promise,
        })
      );
      let aChildDfd = createDeferred();
      await A.loaders.aChild.resolve(
        defer({
          critical: "CRITICAL A CHILD",
          lazy: aChildDfd.promise,
        })
      );
      expect(t.router.state.loaderData).toEqual({
        a: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(),
        },
        aChild: {
          critical: "CRITICAL A CHILD",
          lazy: expect.trackedPromise(),
        },
      });

      // Perform an invalid navigation to /b/child which should cancel all
      // pending deferred's since nothing is reused.  It should not call bChild's
      // loader since it's below the boundary but should call b's loader.
      let formData = new FormData();
      formData.append("file", new Blob(["1", "2"]), "file.txt");
      let B = await t.navigate("/b/child", {
        formMethod: "get",
        formData,
      });

      // Both should be cancelled
      await aDfd.resolve("Nope!");
      await aChildDfd.resolve("Nope!");
      expect(t.router.state.loaderData).toEqual({
        a: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(null, null, true),
        },
        aChild: {
          critical: "CRITICAL A CHILD",
          lazy: expect.trackedPromise(null, null, true),
        },
      });

      await B.loaders.b.resolve("B LOADER");
      expect(t.router.state.loaderData).toEqual({
        b: "B LOADER",
      });
      expect(t.router.state.errors).toEqual({
        bChild: new ErrorResponse(
          400,
          "Bad Request",
          "Cannot submit binary form data using GET"
        ),
      });
      expect(B.loaders.bChild.stub).not.toHaveBeenCalled();
    });

    it("does not cancel pending deferreds on hash change only navigations", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
            loader: true,
          },
          {
            id: "lazy",
            path: "lazy",
            loader: true,
          },
        ],
        hydrationData: { loaderData: { index: "INDEX" } },
        initialEntries: ["/"],
      });

      let A = await t.navigate("/lazy");
      let dfd = createDeferred();
      await A.loaders.lazy.resolve(
        defer({
          critical: "CRITICAL",
          lazy: dfd.promise,
        })
      );

      await t.navigate("/lazy#hash");
      expect(t.router.state.loaderData).toEqual({
        lazy: {
          critical: "CRITICAL",
          lazy: expect.trackedPromise(),
        },
      });

      await dfd.resolve("Yep!");
      expect(t.router.state.loaderData).toEqual({
        lazy: {
          critical: "CRITICAL",
          lazy: expect.trackedPromise("Yep!"),
        },
      });
    });

    it("cancels pending deferreds on action submissions", async () => {
      let shouldRevalidateSpy = jest.fn(() => false);
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
            loader: true,
          },
          {
            id: "parent",
            path: "parent",
            loader: true,
            shouldRevalidate: shouldRevalidateSpy,
            children: [
              {
                id: "a",
                path: "a",
                loader: true,
              },
              {
                id: "b",
                path: "b",
                action: true,
              },
            ],
          },
        ],
        hydrationData: { loaderData: { index: "INDEX" } },
        initialEntries: ["/"],
      });

      let A = await t.navigate("/parent/a");
      let parentDfd = createDeferred();
      await A.loaders.parent.resolve(
        defer({
          critical: "CRITICAL PARENT",
          lazy: parentDfd.promise,
        })
      );
      let aDfd = createDeferred();
      await A.loaders.a.resolve(
        defer({
          critical: "CRITICAL A",
          lazy: aDfd.promise,
        })
      );

      // Action submission causes all to be cancelled, even reused ones, and
      // ignores shouldRevalidate since the cancelled active deferred means we
      // are missing data
      let B = await t.navigate("/parent/b", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      await parentDfd.resolve("Nope!");
      await aDfd.resolve("Nope!");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(null, null, true),
        },
        a: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(null, null, true),
        },
      });

      await B.actions.b.resolve("ACTION");
      let parentDfd2 = createDeferred();
      await B.loaders.parent.resolve(
        defer({
          critical: "CRITICAL PARENT 2",
          lazy: parentDfd2.promise,
        })
      );
      expect(t.router.state.actionData).toEqual({
        b: "ACTION",
      });
      // Since we still have outstanding deferreds on the revalidation, we're
      // still in the loading state and showing the old data
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(null, null, true),
        },
        a: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(null, null, true),
        },
      });

      await parentDfd2.resolve("Yep!");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT 2",
          lazy: expect.trackedPromise("Yep!"),
        },
      });

      expect(shouldRevalidateSpy).not.toHaveBeenCalled();
    });

    it("does not put resolved deferred's back into a loading state during revalidation", async () => {
      let shouldRevalidateSpy = jest.fn(() => false);
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
            loader: true,
          },
          {
            id: "parent",
            path: "parent",
            loader: true,
            shouldRevalidate: shouldRevalidateSpy,
            children: [
              {
                id: "a",
                path: "a",
                loader: true,
              },
              {
                id: "b",
                path: "b",
                action: true,
                loader: true,
              },
            ],
          },
        ],
        hydrationData: { loaderData: { index: "INDEX" } },
        initialEntries: ["/"],
      });

      // Route to /parent/a and return and resolve deferred's for both
      let A = await t.navigate("/parent/a");
      let parentDfd1 = createDeferred();
      let parentDfd2 = createDeferred();
      await A.loaders.parent.resolve(
        defer({
          critical: "CRITICAL PARENT",
          lazy1: parentDfd1.promise,
          lazy2: parentDfd2.promise,
        })
      );
      let aDfd1 = createDeferred();
      let aDfd2 = createDeferred();
      await A.loaders.a.resolve(
        defer({
          critical: "CRITICAL A",
          lazy1: aDfd1.promise,
          lazy2: aDfd2.promise,
        })
      );

      // Resolve one of the deferred for each prior to the action submission
      await parentDfd1.resolve("LAZY PARENT 1");
      await aDfd1.resolve("LAZY A 1");

      // Action submission causes all to be cancelled, even reused ones, and
      // ignores shouldRevalidate since the cancelled active deferred means we
      // are missing data
      let B = await t.navigate("/parent/b", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      await parentDfd2.resolve("Nope!");
      await aDfd2.resolve("Nope!");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy1: expect.trackedPromise("LAZY PARENT 1"),
          lazy2: expect.trackedPromise(null, null, true),
        },
        a: {
          critical: "CRITICAL A",
          lazy1: expect.trackedPromise("LAZY A 1"),
          lazy2: expect.trackedPromise(null, null, true),
        },
      });

      await B.actions.b.resolve("ACTION");
      let parentDfd1Revalidation = createDeferred();
      let parentDfd2Revalidation = createDeferred();
      await B.loaders.parent.resolve(
        defer({
          critical: "CRITICAL PARENT*",
          lazy1: parentDfd1Revalidation.promise,
          lazy2: parentDfd2Revalidation.promise,
        })
      );
      await B.loaders.b.resolve("B");

      // At this point, we resolved the action and the loaders - however the
      // parent loader returned a deferred so we stay in the "loading" state
      // until everything resolves
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.actionData).toEqual({
        b: "ACTION",
      });
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy1: expect.trackedPromise("LAZY PARENT 1"),
          lazy2: expect.trackedPromise(null, null, true),
        },
        a: {
          critical: "CRITICAL A",
          lazy1: expect.trackedPromise("LAZY A 1"),
          lazy2: expect.trackedPromise(null, null, true),
        },
      });

      // Resolve the first deferred - should not complete the navigation yet
      await parentDfd1Revalidation.resolve("LAZY PARENT 1*");
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy1: expect.trackedPromise("LAZY PARENT 1"),
          lazy2: expect.trackedPromise(null, null, true),
        },
        a: {
          critical: "CRITICAL A",
          lazy1: expect.trackedPromise("LAZY A 1"),
          lazy2: expect.trackedPromise(null, null, true),
        },
      });

      await parentDfd2Revalidation.resolve("LAZY PARENT 2*");
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.actionData).toEqual({
        b: "ACTION",
      });
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT*",
          lazy1: expect.trackedPromise("LAZY PARENT 1*"),
          lazy2: expect.trackedPromise("LAZY PARENT 2*"),
        },
        b: "B",
      });

      expect(shouldRevalidateSpy).not.toHaveBeenCalled();
    });

    it("triggers fallbacks on new dynamic route instances", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
            loader: true,
          },
          {
            id: "invoice",
            path: "invoices/:id",
            loader: true,
          },
        ],
        hydrationData: { loaderData: { index: "INDEX" } },
        initialEntries: ["/"],
      });

      let A = await t.navigate("/invoices/1");
      let dfd1 = createDeferred();
      await A.loaders.invoice.resolve(defer({ lazy: dfd1.promise }));
      expect(t.router.state.loaderData).toEqual({
        invoice: {
          lazy: expect.trackedPromise(),
        },
      });

      await dfd1.resolve("DATA 1");
      expect(t.router.state.loaderData).toEqual({
        invoice: {
          lazy: expect.trackedPromise("DATA 1"),
        },
      });

      // Goes back into a loading state since this is a new instance of the
      // invoice route
      let B = await t.navigate("/invoices/2");
      let dfd2 = createDeferred();
      await B.loaders.invoice.resolve(defer({ lazy: dfd2.promise }));
      expect(t.router.state.loaderData).toEqual({
        invoice: {
          lazy: expect.trackedPromise(),
        },
      });

      await dfd2.resolve("DATA 2");
      expect(t.router.state.loaderData).toEqual({
        invoice: {
          lazy: expect.trackedPromise("DATA 2"),
        },
      });
    });

    it("triggers fallbacks on new splat route instances", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
            loader: true,
          },
          {
            id: "invoices",
            path: "invoices",
            children: [
              {
                id: "invoice",
                path: "*",
                loader: true,
              },
            ],
          },
        ],
        hydrationData: { loaderData: { index: "INDEX" } },
        initialEntries: ["/"],
      });

      let A = await t.navigate("/invoices/1");
      let dfd1 = createDeferred();
      await A.loaders.invoice.resolve(defer({ lazy: dfd1.promise }));
      expect(t.router.state.loaderData).toEqual({
        invoice: {
          lazy: expect.trackedPromise(),
        },
      });

      await dfd1.resolve("DATA 1");
      expect(t.router.state.loaderData).toEqual({
        invoice: {
          lazy: expect.trackedPromise("DATA 1"),
        },
      });

      // Goes back into a loading state since this is a new instance of the
      // invoice route
      let B = await t.navigate("/invoices/2");
      let dfd2 = createDeferred();
      await B.loaders.invoice.resolve(defer({ lazy: dfd2.promise }));
      expect(t.router.state.loaderData).toEqual({
        invoice: {
          lazy: expect.trackedPromise(),
        },
      });

      await dfd2.resolve("DATA 2");
      expect(t.router.state.loaderData).toEqual({
        invoice: {
          lazy: expect.trackedPromise("DATA 2"),
        },
      });
    });

    it("cancels awaited reused deferreds on subsequent navigations", async () => {
      let shouldRevalidateSpy = jest.fn(() => false);
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
            loader: true,
          },
          {
            id: "parent",
            path: "parent",
            loader: true,
            shouldRevalidate: shouldRevalidateSpy,
            children: [
              {
                id: "a",
                path: "a",
                loader: true,
              },
              {
                id: "b",
                path: "b",
                action: true,
                loader: true,
              },
            ],
          },
        ],
        hydrationData: { loaderData: { index: "INDEX" } },
        initialEntries: ["/"],
      });

      // Route to /parent/a and return and resolve deferred's for both
      let A = await t.navigate("/parent/a");
      let parentDfd = createDeferred(); // Never resolves in this test
      await A.loaders.parent.resolve(
        defer({
          critical: "CRITICAL PARENT",
          lazy: parentDfd.promise,
        })
      );
      let aDfd = createDeferred();
      await A.loaders.a.resolve(
        defer({
          critical: "CRITICAL A",
          lazy: aDfd.promise,
        })
      );

      // Action submission to cancel deferreds
      let B = await t.navigate("/parent/b", {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(),
        },
        a: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(),
        },
      });

      await B.actions.b.resolve("ACTION");
      let parentDfd2 = createDeferred(); // Never resolves in this test
      await B.loaders.parent.resolve(
        defer({
          critical: "CRITICAL PARENT*",
          lazy: parentDfd2.promise,
        })
      );
      await B.loaders.b.resolve("B");

      // Still in loading state due to revalidation deferred
      expect(t.router.state.navigation.state).toBe("loading");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(null, null, true),
        },
        a: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(null, null, true),
        },
      });

      // Navigate elsewhere - should cancel/abort revalidation deferreds
      let C = await t.navigate("/");
      await C.loaders.index.resolve("INDEX*");
      expect(t.router.state.navigation.state).toBe("idle");
      expect(t.router.state.actionData).toEqual(null);
      expect(t.router.state.loaderData).toEqual({
        index: "INDEX*",
      });
    });

    it("does not support deferred data on fetcher loads", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
          },
          {
            id: "fetch",
            path: "fetch",
            loader: true,
          },
        ],
        initialEntries: ["/"],
      });

      let key = "key";
      let A = await t.fetch("/fetch", key);

      // deferred in a fetcher awaits all data in the loading state
      let dfd = createDeferred();
      await A.loaders.fetch.resolve(
        defer({
          critical: "1",
          lazy: dfd.promise,
        })
      );
      expect(t.router.state.fetchers.get(key)).toMatchObject({
        state: "loading",
        data: undefined,
      });

      await dfd.resolve("2");
      expect(t.router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: {
          critical: "1",
          lazy: "2",
        },
      });

      // Trigger a revalidation for the same fetcher
      let B = await t.revalidate("fetch", "fetch");
      expect(t.router.state.revalidation).toBe("loading");
      let dfd2 = createDeferred();
      await B.loaders.fetch.resolve(
        defer({
          critical: "3",
          lazy: dfd2.promise,
        })
      );
      expect(t.router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: {
          critical: "1",
          lazy: "2",
        },
      });

      await dfd2.resolve("4");
      expect(t.router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: {
          critical: "3",
          lazy: "4",
        },
      });
    });

    it("triggers error boundaries if fetcher deferred data rejects", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
          },
          {
            id: "fetch",
            path: "fetch",
            loader: true,
          },
        ],
        initialEntries: ["/"],
      });

      let key = "key";
      let A = await t.fetch("/fetch", key);

      let dfd = createDeferred();
      await A.loaders.fetch.resolve(
        defer({
          critical: "1",
          lazy: dfd.promise,
        })
      );
      await dfd.reject(new Error("Kaboom!"));
      expect(t.router.state.errors).toMatchObject({
        index: new Error("Kaboom!"),
      });
      expect(t.router.state.fetchers.get(key)).toBeUndefined();
    });

    it("cancels pending deferreds on fetcher reloads", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
          },
          {
            id: "fetch",
            path: "fetch",
            loader: true,
          },
        ],
        initialEntries: ["/"],
      });

      let key = "key";
      let A = await t.fetch("/fetch", key);

      // deferred in a fetcher awaits all data in the loading state
      let dfd1 = createDeferred();
      let loaderPromise1 = A.loaders.fetch.resolve(
        defer({
          critical: "1",
          lazy: dfd1.promise,
        })
      );
      expect(t.router.state.fetchers.get(key)).toMatchObject({
        state: "loading",
        data: undefined,
      });

      // Fetch again
      let B = await t.fetch("/fetch", key);

      let dfd2 = createDeferred();
      let loaderPromise2 = B.loaders.fetch.resolve(
        defer({
          critical: "3",
          lazy: dfd2.promise,
        })
      );
      expect(t.router.state.fetchers.get(key)).toMatchObject({
        state: "loading",
        data: undefined,
      });

      // Resolving the second finishes us up
      await dfd1.resolve("2");
      await dfd2.resolve("4");
      await loaderPromise1;
      await loaderPromise2;
      expect(t.router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: {
          critical: "3",
          lazy: "4",
        },
      });
    });

    it("cancels pending deferreds on fetcher action submissions", async () => {
      let t = setup({
        routes: [
          {
            id: "index",
            index: true,
            loader: true,
          },
          {
            id: "parent",
            path: "parent",
            loader: true,
            shouldRevalidate: () => false,
            children: [
              {
                id: "a",
                path: "a",
                loader: true,
              },
              {
                id: "b",
                path: "b",
                action: true,
              },
            ],
          },
        ],
        hydrationData: { loaderData: { index: "INDEX" } },
        initialEntries: ["/"],
      });

      let A = await t.navigate("/parent/a");
      let parentDfd = createDeferred();
      await A.loaders.parent.resolve(
        defer({
          critical: "CRITICAL PARENT",
          lazy: parentDfd.promise,
        })
      );
      let aDfd = createDeferred();
      await A.loaders.a.resolve(
        defer({
          critical: "CRITICAL A",
          lazy: aDfd.promise,
        })
      );

      // Fetcher action submission causes all to be cancelled and
      // ignores shouldRevalidate since the cancelled active deferred means we
      // are missing data
      let key = "key";
      let B = await t.fetch("/parent/b", key, {
        formMethod: "post",
        formData: createFormData({ key: "value" }),
      });
      await parentDfd.resolve("Nope!");
      await aDfd.resolve("Nope!");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(null, null, true),
        },
        a: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(null, null, true),
        },
      });

      await B.actions.b.resolve("ACTION");
      expect(t.router.state.fetchers.get(key)).toMatchObject({
        state: "loading",
        data: "ACTION",
      });

      await B.actions.b.resolve("ACTION");
      let parentDfd2 = createDeferred();
      await B.loaders.parent.resolve(
        defer({
          critical: "CRITICAL PARENT 2",
          lazy: parentDfd2.promise,
        })
      );
      let aDfd2 = createDeferred();
      await B.loaders.a.resolve(
        defer({
          critical: "CRITICAL A 2",
          lazy: aDfd2.promise,
        })
      );

      // Still showing old data while we wait on revalidation deferreds to
      // complete
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT",
          lazy: expect.trackedPromise(null, null, true),
        },
        a: {
          critical: "CRITICAL A",
          lazy: expect.trackedPromise(null, null, true),
        },
      });

      await parentDfd2.resolve("Yep!");
      await aDfd2.resolve("Yep!");
      expect(t.router.state.loaderData).toEqual({
        parent: {
          critical: "CRITICAL PARENT 2",
          lazy: expect.trackedPromise("Yep!"),
        },
        a: {
          critical: "CRITICAL A 2",
          lazy: expect.trackedPromise("Yep!"),
        },
      });
      expect(t.router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: "ACTION",
      });
    });

    it("differentiates between navigation and fetcher deferreds on cancellations", async () => {
      let dfds: Array<ReturnType<typeof createDeferred>> = [];
      let signals: Array<AbortSignal> = [];
      let router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/"] }),
        routes: [
          {
            id: "root",
            path: "/",
            loader: ({ request }) => {
              let dfd = createDeferred();
              dfds.push(dfd);
              signals.push(request.signal);
              return defer({ value: dfd.promise });
            },
          },
        ],
        hydrationData: {
          loaderData: {
            root: { value: -1 },
          },
        },
      });

      // navigate to root, kicking off a reload of the root loader
      let key = "key";
      router.navigate("/");
      router.fetch(key, "root", "/");
      await tick();
      expect(router.state.navigation.state).toBe("loading");
      expect(router.state.loaderData).toEqual({
        root: { value: -1 },
      });
      expect(router.state.fetchers.get(key)).toMatchObject({
        state: "loading",
        data: undefined,
      });

      // Interrupt with a revalidation
      router.revalidate();

      // Original deferreds should do nothing on resolution
      dfds[0].resolve(0);
      dfds[1].resolve(1);
      await tick();
      expect(router.state.navigation.state).toBe("loading");
      expect(router.state.loaderData).toEqual({
        root: { value: -1 },
      });
      expect(router.state.fetchers.get(key)).toMatchObject({
        state: "loading",
        data: undefined,
      });

      // New deferreds should complete the revalidation
      dfds[2].resolve(2);
      dfds[3].resolve(3);
      await tick();
      expect(router.state.navigation.state).toBe("idle");
      expect(router.state.loaderData).toEqual({
        root: { value: expect.trackedPromise(2) },
      });
      expect(router.state.fetchers.get(key)).toMatchObject({
        state: "idle",
        data: { value: 3 },
      });

      // Assert that both the route loader and fetcher loader were aborted
      expect(signals[0].aborted).toBe(true); // initial route
      expect(signals[1].aborted).toBe(true); // initial fetcher
      expect(signals[2].aborted).toBe(false); // revalidating route
      expect(signals[3].aborted).toBe(false); // revalidating fetcher

      expect(router._internalActiveDeferreds.size).toBe(0);
      expect(router._internalFetchControllers.size).toBe(0);
      router.dispose();
    });
  });

  describe("ssr", () => {
    const SSR_ROUTES = [
      {
        id: "index",
        path: "/",
        loader: () => "INDEX LOADER",
      },
      {
        id: "parent",
        path: "/parent",
        loader: () => "PARENT LOADER",
        action: () => "PARENT ACTION",
        children: [
          {
            id: "parentIndex",
            index: true,
            loader: () => "PARENT INDEX LOADER",
            action: () => "PARENT INDEX ACTION",
          },
          {
            id: "child",
            path: "child",
            loader: () => "CHILD LOADER",
            action: () => "CHILD ACTION",
          },
          {
            id: "json",
            path: "json",
            loader: () => json({ type: "loader" }),
            action: () => json({ type: "action" }),
          },
          {
            id: "deferred",
            path: "deferred",
            loader: () =>
              defer({
                critical: "loader",
                lazy: new Promise((r) => setTimeout(() => r("lazy"), 10)),
              }),
            action: () =>
              defer({
                critical: "action",
                lazy: new Promise((r) => setTimeout(() => r("lazy"), 10)),
              }),
          },
          {
            id: "error",
            path: "error",
            loader: () => Promise.reject("ERROR LOADER ERROR"),
            action: () => Promise.reject("ERROR ACTION ERROR"),
          },
          {
            id: "errorBoundary",
            path: "error-boundary",
            hasErrorBoundary: true,
            loader: () => Promise.reject("ERROR BOUNDARY LOADER ERROR"),
            action: () => Promise.reject("ERROR BOUNDARY ACTION ERROR"),
          },
        ],
      },
      {
        id: "redirect",
        path: "/redirect",
        loader: () => redirect("/"),
      },
    ];

    function createRequest(path: string, opts?: RequestInit) {
      return new Request(`http://localhost${path}`, {
        signal: new AbortController().signal,
        ...opts,
      });
    }

    function createSubmitRequest(path: string, opts?: RequestInit) {
      return createRequest(path, {
        method: "post",
        body: createFormData({ key: "value" }),
        ...opts,
      });
    }

    describe("document requests", () => {
      it("should support document load navigations", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let context = await query(createRequest("/parent/child"));
        expect(context).toMatchObject({
          actionData: null,
          loaderData: {
            parent: "PARENT LOADER",
            child: "CHILD LOADER",
          },
          errors: null,
          location: { pathname: "/parent/child" },
          matches: [{ route: { id: "parent" } }, { route: { id: "child" } }],
        });
      });

      it("should support document load navigations returning responses", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let context = await query(createRequest("/parent/json"));
        expect(context).toMatchObject({
          actionData: null,
          loaderData: {
            parent: "PARENT LOADER",
            json: { type: "loader" },
          },
          errors: null,
          matches: [{ route: { id: "parent" } }, { route: { id: "json" } }],
        });
      });

      // Note: this is only until we wire up the remix streaming
      it("should abort deferred data on load navigations (for now)", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let context = await query(createRequest("/parent/deferred"));
        expect(context).toMatchObject({
          actionData: null,
          loaderData: {
            parent: "PARENT LOADER",
            deferred: {
              critical: "loader",
              lazy: expect.trackedPromise(null, null, true),
            },
          },
          errors: null,
          location: { pathname: "/parent/deferred" },
          matches: [{ route: { id: "parent" } }, { route: { id: "deferred" } }],
        });

        await new Promise((r) => setTimeout(r, 10));
        expect(
          (context as StaticHandlerContext).loaderData.deferred.lazy instanceof
            Promise
        ).toBe(true);
      });

      it("should support document submit navigations", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let context = await query(createSubmitRequest("/parent/child"));
        expect(context).toMatchObject({
          actionData: {
            child: "CHILD ACTION",
          },
          loaderData: {
            parent: "PARENT LOADER",
            child: "CHILD LOADER",
          },
          errors: null,
          location: { pathname: "/parent/child" },
          matches: [{ route: { id: "parent" } }, { route: { id: "child" } }],
        });
      });

      it("should support document submit navigations returning responses", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let context = await query(createSubmitRequest("/parent/json"));
        expect(context).toMatchObject({
          actionData: {
            json: { type: "action" },
          },
          loaderData: {
            parent: "PARENT LOADER",
            json: { type: "loader" },
          },
          errors: null,
          matches: [{ route: { id: "parent" } }, { route: { id: "json" } }],
        });
      });

      it("should support document submit navigations to layout routes", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let context = await query(createSubmitRequest("/parent"));
        expect(context).toMatchObject({
          actionData: {
            parent: "PARENT ACTION",
          },
          loaderData: {
            parent: "PARENT LOADER",
            parentIndex: "PARENT INDEX LOADER",
          },
          errors: null,
          matches: [
            { route: { id: "parent" } },
            { route: { id: "parentIndex" } },
          ],
        });
      });

      it("should support document submit navigations to index routes", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let context = await query(createSubmitRequest("/parent?index"));
        expect(context).toMatchObject({
          actionData: {
            parentIndex: "PARENT INDEX ACTION",
          },
          loaderData: {
            parent: "PARENT LOADER",
            parentIndex: "PARENT INDEX LOADER",
          },
          errors: null,
          matches: [
            { route: { id: "parent" } },
            { route: { id: "parentIndex" } },
          ],
        });
      });

      it("should handle redirect Responses", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let redirect = await query(createRequest("/redirect"));
        expect(redirect instanceof Response).toBe(true);
        expect((redirect as Response).status).toBe(302);
        expect((redirect as Response).headers.get("Location")).toBe("/");
      });

      it("should handle 404 navigations", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let context = await query(createRequest("/not/found"));

        expect(context).toMatchObject({
          loaderData: {},
          actionData: null,
          errors: {
            index: {
              data: null,
              status: 404,
              statusText: "Not Found",
            },
          },
          matches: [{ route: { id: "index" } }],
        });
      });

      it("should handle load error responses", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let context;

        // Error handled by child
        context = await query(createRequest("/parent/error-boundary"));
        expect(context).toMatchObject({
          actionData: null,
          loaderData: {
            parent: "PARENT LOADER",
          },
          errors: {
            errorBoundary: "ERROR BOUNDARY LOADER ERROR",
          },
          matches: [
            { route: { id: "parent" } },
            { route: { id: "errorBoundary" } },
          ],
        });

        // Error propagates to parent
        context = await query(createRequest("/parent/error"));
        expect(context).toMatchObject({
          actionData: null,
          loaderData: {
            parent: "PARENT LOADER",
          },
          errors: {
            parent: "ERROR LOADER ERROR",
          },
          matches: [{ route: { id: "parent" } }, { route: { id: "error" } }],
        });
      });

      it("should handle submit error responses", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let context;

        // Error handled by child
        context = await query(createSubmitRequest("/parent/error-boundary"));
        expect(context).toMatchObject({
          actionData: null,
          loaderData: {
            parent: "PARENT LOADER",
          },
          errors: {
            errorBoundary: "ERROR BOUNDARY ACTION ERROR",
          },
          matches: [
            { route: { id: "parent" } },
            { route: { id: "errorBoundary" } },
          ],
        });

        // Error propagates to parent
        context = await query(createSubmitRequest("/parent/error"));
        expect(context).toMatchObject({
          actionData: null,
          loaderData: {},
          errors: {
            parent: "ERROR ACTION ERROR",
          },
          matches: [{ route: { id: "parent" } }, { route: { id: "error" } }],
        });
      });

      it("should handle aborted load requests", async () => {
        let dfd = createDeferred();
        let controller = new AbortController();
        let { query } = createStaticHandler([
          {
            id: "root",
            path: "/",
            loader: () => dfd.promise,
          },
        ]);
        let request = createRequest("/", { signal: controller.signal });
        let e;
        try {
          let contextPromise = query(request);
          controller.abort();
          // This should resolve even though we never resolved the loader
          await contextPromise;
        } catch (_e) {
          e = _e;
        }
        expect(e).toMatchInlineSnapshot(`[Error: query() call aborted]`);
      });

      it("should handle aborted submit requests", async () => {
        let dfd = createDeferred();
        let controller = new AbortController();
        let { query } = createStaticHandler([
          {
            id: "root",
            path: "/",
            action: () => dfd.promise,
          },
        ]);
        let request = createSubmitRequest("/", {
          signal: controller.signal,
        });
        let e;
        try {
          let contextPromise = query(request);
          controller.abort();
          // This should resolve even though we never resolved the loader
          await contextPromise;
        } catch (_e) {
          e = _e;
        }
        expect(e).toMatchInlineSnapshot(`[Error: query() call aborted]`);
      });

      it("should not support HEAD requests", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let request = createRequest("/", { method: "head" });
        let e;
        try {
          await query(request);
        } catch (_e) {
          e = _e;
        }
        expect(e).toMatchInlineSnapshot(
          `[Error: query()/queryRoute() do not support HEAD requests]`
        );
      });

      it("should require a signal on the request", async () => {
        let { query } = createStaticHandler(SSR_ROUTES);
        let request = createRequest("/", { signal: undefined });
        let e;
        try {
          await query(request);
        } catch (_e) {
          e = _e;
        }
        expect(e).toMatchInlineSnapshot(
          `[Error: query()/queryRoute() requests must contain an AbortController signal]`
        );
      });

      it("should handle not found action submissions with a 405 error", async () => {
        let { query } = createStaticHandler([
          {
            id: "root",
            path: "/",
          },
        ]);
        let request = createSubmitRequest("/");
        let context = await query(request);
        expect(context).toMatchObject({
          actionData: null,
          loaderData: {},
          errors: {
            root: {
              status: 405,
              statusText: "Method Not Allowed",
              data: "No action found for [/]",
            },
          },
          matches: [{ route: { id: "root" } }],
        });
      });

      describe("statusCode", () => {
        it("should expose a 200 status code by default", async () => {
          let { query } = createStaticHandler([
            {
              id: "root",
              path: "/",
            },
          ]);
          let context = (await query(
            createRequest("/")
          )) as StaticHandlerContext;
          expect(context.statusCode).toBe(200);
        });

        it("should expose a 500 status code on loader errors", async () => {
          let { query } = createStaticHandler([
            {
              id: "root",
              path: "/",
              loader: () => json({ data: "ROOT" }, { status: 201 }),
              children: [
                {
                  id: "child",
                  index: true,
                  loader: () => {
                    throw new Error("💥");
                  },
                },
              ],
            },
          ]);
          let context = (await query(
            createRequest("/")
          )) as StaticHandlerContext;
          expect(context.statusCode).toBe(500);
        });

        it("should expose a 500 status code on action errors", async () => {
          let { query } = createStaticHandler([
            {
              id: "root",
              path: "/",
              loader: () => json({ data: "ROOT" }, { status: 201 }),
              children: [
                {
                  id: "child",
                  index: true,
                  loader: () => json({ data: "CHILD" }, { status: 202 }),
                  action: () => {
                    throw new Error("💥");
                  },
                },
              ],
            },
          ]);
          let context = (await query(
            createSubmitRequest("/?index")
          )) as StaticHandlerContext;
          expect(context.statusCode).toBe(500);
        });

        it("should expose a 4xx status code on thrown loader responses", async () => {
          let { query } = createStaticHandler([
            {
              id: "root",
              path: "/",
              loader: () => json({ data: "ROOT" }, { status: 201 }),
              children: [
                {
                  id: "child",
                  index: true,
                  loader: () => {
                    throw new Response(null, { status: 400 });
                  },
                },
              ],
            },
          ]);
          let context = (await query(
            createRequest("/")
          )) as StaticHandlerContext;
          expect(context.statusCode).toBe(400);
        });

        it("should expose a 4xx status code on thrown action responses", async () => {
          let { query } = createStaticHandler([
            {
              id: "root",
              path: "/",
              loader: () => json({ data: "ROOT" }, { status: 201 }),
              children: [
                {
                  id: "child",
                  index: true,
                  loader: () => json({ data: "CHILD" }, { status: 202 }),
                  action: () => {
                    throw new Response(null, { status: 400 });
                  },
                },
              ],
            },
          ]);
          let context = (await query(
            createSubmitRequest("/?index")
          )) as StaticHandlerContext;
          expect(context.statusCode).toBe(400);
        });

        it("should expose the action status on submissions", async () => {
          let { query } = createStaticHandler([
            {
              id: "root",
              path: "/",
              loader: () => json({ data: "ROOT" }, { status: 201 }),
              children: [
                {
                  id: "child",
                  index: true,
                  loader: () => json({ data: "ROOT" }, { status: 202 }),
                  action: () => json({ data: "ROOT" }, { status: 203 }),
                },
              ],
            },
          ]);
          let context = (await query(
            createSubmitRequest("/?index")
          )) as StaticHandlerContext;
          expect(context.statusCode).toBe(203);
        });

        it("should expose the deepest 2xx status", async () => {
          let { query } = createStaticHandler([
            {
              id: "root",
              path: "/",
              loader: () => json({ data: "ROOT" }, { status: 201 }),
              children: [
                {
                  id: "child",
                  index: true,
                  loader: () => json({ data: "ROOT" }, { status: 202 }),
                },
              ],
            },
          ]);
          let context = (await query(
            createRequest("/")
          )) as StaticHandlerContext;
          expect(context.statusCode).toBe(202);
        });

        it("should expose the shallowest 4xx/5xx status", async () => {
          let context;
          let query: StaticHandler["query"];

          query = createStaticHandler([
            {
              id: "root",
              path: "/",
              loader: () => {
                throw new Response(null, { status: 400 });
              },
              children: [
                {
                  id: "child",
                  index: true,
                  loader: () => {
                    throw new Response(null, { status: 401 });
                  },
                },
              ],
            },
          ]).query;
          context = (await query(createRequest("/"))) as StaticHandlerContext;
          expect(context.statusCode).toBe(400);

          query = createStaticHandler([
            {
              id: "root",
              path: "/",
              loader: () => {
                throw new Response(null, { status: 400 });
              },
              children: [
                {
                  id: "child",
                  index: true,
                  loader: () => {
                    throw new Response(null, { status: 500 });
                  },
                },
              ],
            },
          ]).query;
          context = (await query(createRequest("/"))) as StaticHandlerContext;
          expect(context.statusCode).toBe(400);

          query = createStaticHandler([
            {
              id: "root",
              path: "/",
              loader: () => {
                throw new Response(null, { status: 400 });
              },
              children: [
                {
                  id: "child",
                  index: true,
                  loader: () => {
                    throw new Error("💥");
                  },
                },
              ],
            },
          ]).query;
          context = (await query(createRequest("/"))) as StaticHandlerContext;
          expect(context.statusCode).toBe(400);
        });
      });

      describe("headers", () => {
        it("should expose headers from loader responses", async () => {
          let { query } = createStaticHandler([
            {
              id: "root",
              path: "/",
              loader: () => new Response(null, { headers: { one: "1" } }),
              children: [
                {
                  id: "child",
                  index: true,
                  loader: () => new Response(null, { headers: { two: "2" } }),
                },
              ],
            },
          ]);
          let context = (await query(
            createRequest("/")
          )) as StaticHandlerContext;
          expect(Array.from(context.loaderHeaders.root.entries())).toEqual([
            ["one", "1"],
          ]);
          expect(Array.from(context.loaderHeaders.child.entries())).toEqual([
            ["two", "2"],
          ]);
        });

        it("should expose headers from action responses", async () => {
          let { query } = createStaticHandler([
            {
              id: "root",
              path: "/",
              loader: () => new Response(null, { headers: { two: "2" } }),
              children: [
                {
                  id: "child",
                  index: true,
                  action: () => new Response(null, { headers: { one: "1" } }),
                  loader: () => new Response(null, { headers: { three: "3" } }),
                },
              ],
            },
          ]);
          let context = (await query(
            createSubmitRequest("/?index")
          )) as StaticHandlerContext;
          expect(Array.from(context.actionHeaders.child.entries())).toEqual([
            ["one", "1"],
          ]);
          expect(Array.from(context.loaderHeaders.root.entries())).toEqual([
            ["two", "2"],
          ]);
          expect(Array.from(context.loaderHeaders.child.entries())).toEqual([
            ["three", "3"],
          ]);
        });
      });
    });

    describe("singular route requests", () => {
      it("should support singular route load navigations", async () => {
        let { queryRoute } = createStaticHandler(SSR_ROUTES);
        let data;

        // Layout route
        data = await queryRoute(createRequest("/parent"), "parent");
        expect(data).toBe("PARENT LOADER");

        // Index route
        data = await queryRoute(createRequest("/parent"), "parentIndex");
        expect(data).toBe("PARENT INDEX LOADER");

        // Parent in nested route
        data = await queryRoute(createRequest("/parent/child"), "parent");
        expect(data).toBe("PARENT LOADER");

        // Child in nested route
        data = await queryRoute(createRequest("/parent/child"), "child");
        expect(data).toBe("CHILD LOADER");
      });

      it("should support singular route submit navigations", async () => {
        let { queryRoute } = createStaticHandler(SSR_ROUTES);
        let data;

        // Layout route
        data = await queryRoute(createSubmitRequest("/parent"), "parent");
        expect(data).toBe("PARENT ACTION");

        // Index route
        data = await queryRoute(createSubmitRequest("/parent"), "parentIndex");
        expect(data).toBe("PARENT INDEX ACTION");

        // Parent in nested route
        data = await queryRoute(createSubmitRequest("/parent/child"), "parent");
        expect(data).toBe("PARENT ACTION");

        // Child in nested route
        data = await queryRoute(createSubmitRequest("/parent/child"), "child");
        expect(data).toBe("CHILD ACTION");
      });

      it("should not unwrap responses returned from loaders", async () => {
        let response = json({ key: "value" });
        let { queryRoute } = createStaticHandler([
          {
            id: "root",
            path: "/",
            loader: () => Promise.resolve(response),
          },
        ]);
        let request = createRequest("/");
        let data = await queryRoute(request, "root");
        expect(data instanceof Response).toBe(true);
        expect(await data.json()).toEqual({ key: "value" });
      });

      it("should not unwrap responses returned from actions", async () => {
        let response = json({ key: "value" });
        let { queryRoute } = createStaticHandler([
          {
            id: "root",
            path: "/",
            action: () => Promise.resolve(response),
          },
        ]);
        let request = createSubmitRequest("/");
        let data = await queryRoute(request, "root");
        expect(data instanceof Response).toBe(true);
        expect(await data.json()).toEqual({ key: "value" });
      });

      it("should handle load error responses", async () => {
        let { queryRoute } = createStaticHandler(SSR_ROUTES);
        let data;

        data = await queryRoute(createRequest("/parent/error"), "error");
        expect(data).toBe("ERROR LOADER ERROR");
      });

      it("should handle submit error responses", async () => {
        let { queryRoute } = createStaticHandler(SSR_ROUTES);
        let data;

        data = await queryRoute(createSubmitRequest("/parent/error"), "error");
        expect(data).toBe("ERROR ACTION ERROR");
      });

      it("should handle aborted load requests", async () => {
        let dfd = createDeferred();
        let controller = new AbortController();
        let { queryRoute } = createStaticHandler([
          {
            id: "root",
            path: "/",
            loader: () => dfd.promise,
          },
        ]);
        let request = createRequest("/", {
          signal: controller.signal,
        });
        let e;
        try {
          let statePromise = queryRoute(request, "root");
          controller.abort();
          // This should resolve even though we never resolved the loader
          await statePromise;
        } catch (_e) {
          e = _e;
        }
        expect(e).toMatchInlineSnapshot(`[Error: queryRoute() call aborted]`);
      });

      it("should handle aborted submit requests", async () => {
        let dfd = createDeferred();
        let controller = new AbortController();
        let { queryRoute } = createStaticHandler([
          {
            id: "root",
            path: "/",
            action: () => dfd.promise,
          },
        ]);
        let request = createSubmitRequest("/", {
          signal: controller.signal,
        });
        let e;
        try {
          let statePromise = queryRoute(request, "root");
          controller.abort();
          // This should resolve even though we never resolved the loader
          await statePromise;
        } catch (_e) {
          e = _e;
        }
        expect(e).toMatchInlineSnapshot(`[Error: queryRoute() call aborted]`);
      });

      it("should not support HEAD requests", async () => {
        let { queryRoute } = createStaticHandler(SSR_ROUTES);
        let request = createRequest("/", { method: "head" });
        let e;
        try {
          await queryRoute(request, "index");
        } catch (_e) {
          e = _e;
        }
        expect(e).toMatchInlineSnapshot(
          `[Error: query()/queryRoute() do not support HEAD requests]`
        );
      });

      it("should require a signal on the request", async () => {
        let { queryRoute } = createStaticHandler(SSR_ROUTES);
        let request = createRequest("/", { signal: undefined });
        let e;
        try {
          await queryRoute(request, "index");
        } catch (_e) {
          e = _e;
        }
        expect(e).toMatchInlineSnapshot(
          `[Error: query()/queryRoute() requests must contain an AbortController signal]`
        );
      });

      it("should handle not found action submissions with a 405 Response", async () => {
        let { queryRoute } = createStaticHandler([
          {
            id: "root",
            path: "/",
          },
        ]);
        let request = createSubmitRequest("/");
        let data = await queryRoute(request, "root");
        expect(data instanceof Response).toBe(true);
        expect(data.status).toBe(405);
        expect(data.statusText).toBe("Method Not Allowed");
        expect(await data.text()).toBe("No action found for [/]");
      });
    });
  });
});
