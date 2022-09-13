import type {
  ActionFunction,
  ActionFunctionArgs,
  Fetcher,
  HydrationState,
  JsonFunction,
  LoaderFunction,
  LoaderFunctionArgs,
  Location,
  Navigation,
  Params,
  ParamParseKey,
  Path,
  PathMatch,
  PathPattern,
  RedirectFunction,
  Router as RemixRouter,
  ShouldRevalidateFunction,
  To,
} from "@remix-run/router";
import {
  AbortedDeferredError,
  Action as NavigationType,
  createMemoryHistory,
  createPath,
  createRouter,
  defer,
  generatePath,
  isRouteErrorResponse,
  json,
  matchPath,
  matchRoutes,
  parsePath,
  redirect,
  resolvePath,
} from "@remix-run/router";

import type {
  DataMemoryRouterProps,
  AwaitProps,
  MemoryRouterProps,
  NavigateProps,
  OutletProps,
  RouteProps,
  PathRouteProps,
  LayoutRouteProps,
  IndexRouteProps,
  RouterProps,
  RoutesProps,
  RouterProviderProps,
} from "./lib/components";
import {
  enhanceManualRouteObjects,
  createRoutesFromChildren,
  renderMatches,
  Await,
  MemoryRouter,
  Navigate,
  Outlet,
  Route,
  Router,
  RouterProvider,
  Routes,
} from "./lib/components";
import type {
  DataRouteMatch,
  DataRouteObject,
  Navigator,
  NavigateOptions,
  RouteMatch,
  RouteObject,
  RelativeRoutingType,
} from "./lib/context";
import {
  DataRouterContext,
  DataRouterStateContext,
  DataStaticRouterContext,
  LocationContext,
  NavigationContext,
  RouteContext,
} from "./lib/context";
import type { NavigateFunction } from "./lib/hooks";
import {
  useHref,
  useInRouterContext,
  useLocation,
  useMatch,
  useNavigationType,
  useNavigate,
  useOutlet,
  useOutletContext,
  useParams,
  useResolvedPath,
  useRoutes,
  useActionData,
  useAsyncError,
  useAsyncValue,
  useLoaderData,
  useMatches,
  useNavigation,
  useRevalidator,
  useRouteError,
  useRouteLoaderData,
} from "./lib/hooks";

// Exported for backwards compatibility, but not being used internally anymore
type Hash = string;
type Pathname = string;
type Search = string;

// Expose react-router public API
export type {
  ActionFunction,
  ActionFunctionArgs,
  AwaitProps,
  DataMemoryRouterProps,
  DataRouteMatch,
  DataRouteObject,
  Fetcher,
  Hash,
  IndexRouteProps,
  JsonFunction,
  LayoutRouteProps,
  LoaderFunction,
  LoaderFunctionArgs,
  Location,
  MemoryRouterProps,
  NavigateFunction,
  NavigateOptions,
  NavigateProps,
  Navigation,
  Navigator,
  OutletProps,
  Params,
  ParamParseKey,
  Path,
  PathMatch,
  Pathname,
  PathPattern,
  PathRouteProps,
  RedirectFunction,
  RelativeRoutingType,
  RouteMatch,
  RouteObject,
  RouteProps,
  RouterProps,
  RouterProviderProps,
  RoutesProps,
  Search,
  ShouldRevalidateFunction,
  To,
};
export {
  AbortedDeferredError,
  Await,
  MemoryRouter,
  Navigate,
  NavigationType,
  Outlet,
  Route,
  Router,
  RouterProvider,
  Routes,
  createPath,
  createRoutesFromChildren,
  createRoutesFromChildren as createRoutesFromElements,
  defer,
  isRouteErrorResponse,
  generatePath,
  json,
  matchPath,
  matchRoutes,
  parsePath,
  redirect,
  renderMatches,
  resolvePath,
  useActionData,
  useAsyncError,
  useAsyncValue,
  useHref,
  useInRouterContext,
  useLoaderData,
  useLocation,
  useMatch,
  useMatches,
  useNavigate,
  useNavigation,
  useNavigationType,
  useOutlet,
  useOutletContext,
  useParams,
  useResolvedPath,
  useRevalidator,
  useRouteError,
  useRouteLoaderData,
  useRoutes,
};

export function createMemoryRouter(
  routes: RouteObject[],
  opts?: {
    basename?: string;
    hydrationData?: HydrationState;
    initialEntries?: string[];
    initialIndex?: number;
  }
): RemixRouter {
  return createRouter({
    basename: opts?.basename,
    history: createMemoryHistory({
      initialEntries: opts?.initialEntries,
      initialIndex: opts?.initialIndex,
    }),
    hydrationData: opts?.hydrationData,
    routes: enhanceManualRouteObjects(routes),
  }).initialize();
}

///////////////////////////////////////////////////////////////////////////////
// DANGER! PLEASE READ ME!
// We provide these exports as an escape hatch in the event that you need any
// routing data that we don't provide an explicit API for. With that said, we
// want to cover your use case if we can, so if you feel the need to use these
// we want to hear from you. Let us know what you're building and we'll do our
// best to make sure we can support you!
//
// We consider these exports an implementation detail and do not guarantee
// against any breaking changes, regardless of the semver release. Use with
// extreme caution and only if you understand the consequences. Godspeed.
///////////////////////////////////////////////////////////////////////////////

/** @internal */
export {
  NavigationContext as UNSAFE_NavigationContext,
  LocationContext as UNSAFE_LocationContext,
  RouteContext as UNSAFE_RouteContext,
  DataRouterContext as UNSAFE_DataRouterContext,
  DataRouterStateContext as UNSAFE_DataRouterStateContext,
  DataStaticRouterContext as UNSAFE_DataStaticRouterContext,
  enhanceManualRouteObjects as UNSAFE_enhanceManualRouteObjects,
};
