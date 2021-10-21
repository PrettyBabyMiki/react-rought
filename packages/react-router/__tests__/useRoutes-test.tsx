import * as React from "react";
import { create as createTestRenderer } from "react-test-renderer";
import type { RouteObject } from "react-router";
import { MemoryRouter, useRoutes } from "react-router";

describe("useRoutes", () => {
  it("returns the matching element from a route config", () => {
    let routes = [
      { path: "home", element: <h1>home</h1> },
      { path: "about", element: <h1>about</h1> }
    ];

    let renderer = createTestRenderer(
      <MemoryRouter initialEntries={["/home"]}>
        <RoutesRenderer routes={routes} />
      </MemoryRouter>
    );

    expect(renderer.toJSON()).toMatchInlineSnapshot(`
      <h1>
        home
      </h1>
    `);
  });

  describe("when some routes are missing elements", () => {
    it("defaults to rendering their children", () => {
      let routes = [
        {
          path: "users",
          children: [{ path: ":id", element: <h1>user profile</h1> }]
        },
        { path: "about", element: <h1>about</h1> }
      ];

      let renderer = createTestRenderer(
        <MemoryRouter initialEntries={["/users/mj"]}>
          <RoutesRenderer routes={routes} />
        </MemoryRouter>
      );

      expect(renderer.toJSON()).toMatchInlineSnapshot(`
        <h1>
          user profile
        </h1>
      `);
    });
  });

  it("Uses the `location` prop instead of context location`", () => {
    let routes = [
      { path: "one", element: <h1>one</h1> },
      { path: "two", element: <h1>two</h1> }
    ];

    let renderer = createTestRenderer(
      <MemoryRouter initialEntries={["/one"]}>
        <RoutesRenderer routes={routes} location={{ pathname: "/two" }} />
      </MemoryRouter>
    );

    expect(renderer.toJSON()).toMatchInlineSnapshot(`
      <h1>
        two
      </h1>
    `);
  });

  describe("warns", () => {
    let consoleWarn: jest.SpyInstance;
    beforeEach(() => {
      consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleWarn.mockRestore();
    });

    it("for no element on leaf route", () => {
      let routes = [
        {
          path: "layout",
          children: [{ path: "two", element: <h1>two</h1> }]
        }
      ];

      createTestRenderer(
        <MemoryRouter initialEntries={["/layout"]}>
          <RoutesRenderer routes={routes} />
        </MemoryRouter>
      );

      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining(
          `Matched leaf route at location "/layout" does not have an element`
        )
      );
    });
  });
});

function RoutesRenderer({
  routes,
  location
}: {
  routes: RouteObject[];
  location?: Partial<Location> & { pathname: string };
}) {
  return useRoutes(routes, location);
}
