---
title: useFetcher
new: true
---

# `useFetcher`

In HTML/HTTP, data mutations and loads are modeled with navigation: `<a href>` and `<form action>`. Both cause a navigation in the browser. The React Router equivalents are `<Link>` and `<Form>`.

But sometimes you want to call a loader outside of navigation, or call an action (and get the data on the page to revalidate) without changing the URL. Or you need to have multiple mutations in-flight at the same time.

Many interactions with the server aren't navigation events. This hook lets you plug your UI into your actions and loaders without navigating.

This is useful when you need to:

- fetch data not associated with UI routes (popovers, dynamic forms, etc.)
- submit data to actions without navigating (shared components like a newsletter sign ups)
- handle multiple concurrent submissions in a list (typical "todo app" list where you can click multiple buttons and all should be pending at the same time)
- infinite scroll containers
- and more!

If you're building a highly interactive, "app like" user interface, you will `useFetcher` often.

```tsx
import { useFetcher } from "react-router-dom";

function SomeComponent() {
  const fetcher = useFetcher();

  // call submit or load in a useEffect
  React.useEffect(() => {
    fetcher.submit(data, options);
    fetcher.load(href);
  }, [fetcher]);

  // build your UI with these properties
  fetcher.state;
  fetcher.formData;
  fetcher.formMethod;
  fetcher.formAction;
  fetcher.data;

  // render a form that doesn't cause navigation
  return <fetcher.Form />;
}
```

Fetchers have a lot of built-in behavior:

- Automatically handles cancellation on interruptions of the fetch
- When submitting with POST, PUT, PATCH, DELETE, the action is called first
  - After the action completes, the data on the page is revalidated to capture any mutations that may have happened, automatically keeping your UI in sync with your server state
- When multiple fetchers are inflight at once, it will
  - commit the freshest available data as they each land
  - ensure no stale loads override fresher data, no matter which order the responses return
- Handles uncaught errors by rendering the nearest `errorElement` (just like a normal navigation from `<Link>` or `<Form>`)
- Will redirect the app if your action/loader being called returns a redirect (just like a normal navigation from `<Link>` or `<Form>`)

## `fetcher.state`

You can know the state of the fetcher with `fetcher.state`. It will be one of:

- **idle** - nothing is being fetched.
- **submitting** - A form has been submitted. If the method is GET, then the route loader is being called. If POST, PUT, PATCH, or DELETE, then the route action is being called.
- **loading** - The data on the page is being revalidated after an action submission

## `fetcher.Form`

Just like `<Form>` except it doesn't cause a navigation. <small>(You'll get over the dot in JSX ... we hope!)</small>

```tsx
function SomeComponent() {
  const fetcher = useFetcher();
  return (
    <fetcher.Form method="post" action="/some/route">
      <input type="text" />
    </fetcher.Form>
  );
}
```

## `fetcher.load()`

Loads data from a route loader.

```tsx lines=[8]
import { useFetcher } from "react-router-dom";

function SomeComponent() {
  const fetcher = useFetcher();

  useEffect(() => {
    if (fetcher.state === "idle" && !fetcher.data) {
      fetcher.load("/some/route");
    }
  }, [fetcher]);

  return <div>{fetcher.data || "Loading..."}</div>;
}
```

Although a URL might match multiple nested routes, a `fetcher.load()` call will only call the loader on the leaf match (or parent of [index routes][indexsearchparam]).

If you find yourself calling this function inside of click handlers, you can probably simplify your code by using `<fetcher.Form>` instead.

## `fetcher.submit()`

The imperative version of `<fetcher.Form>`. If a user interaction should initiate the fetch, you should use `<fetcher.Form>`. But if you, the programmer are initiating the fetch (not in response to a user clicking a button, etc.), then use this function.

For example, you may want to log the user out after a certain amount of idle time:

```tsx lines=[1,5,10-13]
import { useFetcher } from "react-router-dom";
import { useFakeUserIsIdle } from "./fake/hooks";

export function useIdleLogout() {
  const fetcher = useFetcher();
  const userIsIdle = useFakeUserIsIdle();

  useEffect(() => {
    if (userIsIdle) {
      fetcher.submit(
        { idle: true },
        { method: "post", action: "/logout" }
      );
    }
  }, [userIsIdle]);
}
```

If you want to submit to an index route, use the [`?index` param][indexsearchparam].

If you find yourself calling this function inside of click handlers, you can probably simplify your code by using `<fetcher.Form>` instead.

## `fetcher.data`

The returned data from the loader or action is stored here. Once the data is set, it persists on the fetcher even through reloads and resubmissions.

```tsx
function ProductDetails({ product }) {
  const fetcher = useFetcher();

  return (
    <details
      onToggle={(event) => {
        if (
          event.currentTarget.open &&
          fetcher.state === "idle" &&
          !fetcher.data
        ) {
          fetcher.load(`/product/${product.id}/details`);
        }
      }}
    >
      <summary>{product.name}</summary>
      {fetcher.data ? (
        <div>{fetcher.data}</div>
      ) : (
        <div>Loading product details...</div>
      )}
    </details>
  );
}
```

## `fetcher.formData`

When using `<fetcher.Form>` or `fetcher.submit()`, the form data is available to build optimistic UI.

```tsx
function TaskCheckbox({ task }) {
  let fetcher = useFetcher();

  // while data is in flight, use that to immediately render
  // the state you expect the task to be in when the form
  // submission completes, instead of waiting for the
  // network to respond. When the network responds, the
  // formData will no longer be available and the UI will
  // use the value in `task.status` from the revalidation
  let status =
    fetcher.formData?.get("status") || task.status;

  let isComplete = status === "complete";

  return (
    <fetcher.Form method="post">
      <button
        type="submit"
        name="status"
        value={isComplete ? "incomplete" : "complete"}
      >
        {isComplete ? "Mark Incomplete" : "Mark Complete"}
      </button>
    </fetcher.Form>
  );
}
```

## `fetcher.formAction`

Tells you the action url the form is being submitted to.

```tsx
<fetcher.Form action="/mark-as-read" />;

// when the form is submitting
fetcher.formAction; // "mark-as-read"
```

## `fetcher.formMethod`

Tells you the method of the form being submitted: get, post, put, patch, or delete.

```tsx
<fetcher.Form method="post" />;

// when the form is submitting
fetcher.formMethod; // "post"
```
