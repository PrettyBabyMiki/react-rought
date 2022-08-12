---
title: Form
new: true
---

# `<Form>`

The Form component is a wrapper around a plain HTML [form][htmlform] that emulates the browser for client side routing and data mutations. It is _not_ a form validation/state management library like you might be used to in the React ecosystem (for that, we recommend the browser's built in [HTML Form Validation][formvalidation] and data validation on your backend server).

```tsx
import { Form } from "react-router-dom";

function NewEvent() {
  return (
    <Form method="post" action="/events">
      <input type="text" name="title" />
      <input type="text" name="description" />
      <button type="submit">Create</button>
    </Form>
  );
}
```

<docs-info>Make sure your inputs have names or else the `FormData` will not include that field's value.</docs-info>

All of this will trigger state updates to any rendered [`useNavigation`][usenavigation] hooks so you can build pending indicators and optimistic UI while the async operations are in-flight.

If the form doesn't _feel_ like navigation, you probably want [`useFetcher`][usefetcher].

## `action`

The url to which the form will be submitted, just like [HTML form action][htmlformaction]. The only difference is the default action. With HTML forms, it defaults to the full URL. With `<Form>`, it defaults to the relative URL of the closest route in context.

Consider the following routes and components:

```jsx
function ProjectsLayout() {
  return (
    <>
      <Form method="post" />
      <Outlet />
    </>
  );
}

function ProjectsPage() {
  return <Form method="post" />;
}

<DataBrowserRouter>
  <Route
    path="/projects"
    element={<ProjectsLayout />}
    action={ProjectsLayout.action}
  >
    <Route
      path=":projectId"
      element={<ProjectPage />}
      action={ProjectsPage.action}
    />
  </Route>
</DataBrowserRouter>;
```

If the the current URL is `"/projects/123"`, the form inside the child
route, `ProjectsPage`, will have a default action as you might expect: `"/projects/123"`. In this case, where the route is the deepest matching route, both `<Form>` and plain HTML forms have the same result.

But the form inside of `ProjectsLayout` will point to `"/projects"`, not the full URL. In other words, it points to the matching segment of the URL for the route in which the form is rendered.

This helps with portability as well as co-location of forms and their action handlers when if you add some convention around your route modules.

If you need to post to a different route, then add an action prop:

```tsx
<Form action="/projects/new" method="post" />
```

**See also:**

- [Index Search Param][indexsearchparam] (index vs parent route disambiguation)

## `method`

This determines the [HTTP verb](https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods) to be used. The same as plain HTML [form method][htmlform-method], except it also supports "put", "patch", and "delete" in addition to "get" and "post". The default is "get".

### GET submissions

The default method is "get". Get submissions _will not call an action_. Get submissions are the same as a normal navigation (user clicks a link) except the user gets to supply the search params that go to the URL from the form.

```tsx
<Form method="get" action="/products">
  <input
    aria-label="search products"
    type="text"
    name="q"
  />
  <button type="submit">Search</button>
</Form>
```

Let's say the user types in "running shoes" and submits the form. React Router emulates the browser and will serialize the form into [URLSearchParams][urlsearchparams] and then navigate the user to `"/products?q=running+shoes"`. It's as if you rendered a `<Link to="/products?q=running+shoes">` as the developer, but instead you let the user supply the query string dynamically.

Your route loader can access these values most conveniently by creating a new [`URL`][url] from the `request.url` and then load the data.

```tsx
<Route
  path="/products"
  loader={async ({ request }) => {
    let url = new URL(request.url);
    let searchTerm = url.searchParams.get("q");
    return fakeSearchProducts(searchTerm);
  }}
/>
```

### Mutation Submissions

All other methods are "mutation submissions", meaning you intend to change something about your data with POST, PUT, PATCH, or DELETE. Note that plain HTML forms only support "post" and "get", we tend to stick to those two as well.

When the user submits the form, React Router will match the `action` to the app's routes and call the `<Route action>` with the serialized [`FormData`][formdata]. When the action completes, all of the loader data on the page will automatically revalidate to keep your UI in sync with your data.

The method will be available on [`request.method`][requestmethod] inside the route action that is called. You can use this to instruct your data abstractions about the intent of the submission.

```tsx
<Route
  path="/projects/:id"
  element={<Project />}
  loader={async ({ params }) => {
    return fakeLoadProject(params.id)
  }}
  action={async ({ request, params }) => {
    switch (request.method) {
      case "put": {
        let formData = await request.formData();
        let name = formData.get("projectName");
        return fakeUpdateProject(name);
      }
      case "delete": {
        return fakeDeleteProject(params.id);
      }
      default {
        throw new Response("", { status: 405 })
      }
    }
  }}
/>;

function Project() {
  let project = useLoaderData();

  return (
    <>
      <Form method="put">
        <input
          type="text"
          name="projectName"
          defaultValue={project.name}
        />
        <button type="submit">Update Project</button>
      </Form>

      <Form method="delete">
        <button type="submit">Delete Project</button>
      </Form>
    </>
  );
}
```

As you can see, both forms submit to the same route but you can use the `request.method` to branch on what you intend to do. After the actions completes, the `loader` will be revalidated and the UI will automatically synchronize with the new data.

## `replace`

Instructs the form to replace the current entry in the history stack, instead of pushing the new entry.

```tsx
<Form replace />
```

The default behavior is conditional on the form `method`:

- `get` defaults to `false`
- every other method defaults to `true`

We've found with `get` you often want the user to be able to click "back" to see the previous search results/filters, etc. But with the other methods the default is `true` to avoid the "are you sure you want to resubmit the form?" prompt. Note that even if `replace={false}` React Router _will not_ resubmit the form when the back button is clicked and the method is post, put, patch, or delete.

In other words, this is really only useful for GET submissions and you want to avoid the back button showing the previous results.

## `reloadDocument`

Instructs the form to skip React Router and submit the form with the browser's built in behavior.

```tsx
<Form reloadDocument />
```

This is recommended over `<form>` so you can get the benefits of default and relative `action`, but otherwise is the same as a plain HTML form.

Without a framework like [Remix][remix], or your own server handling of posts to routes, this isn't very useful.

See also:

- [`useNavigation`][usenavigation]
- [`useActionData`][useactiondata]
- [`useSubmit`][usesubmit]

# Examples

TODO: More examples

## Large List Filtering

A common use case for GET submissions is filtering a large list, like ecommerce and travel booking sites.

```tsx
function FilterForm() {
  return (
    <Form method="get" action="/slc/hotels">
      <select name="sort">
        <option value="price">Price</option>
        <option value="stars">Stars</option>
        <option value="distance">Distance</option>
      </select>

      <fieldset>
        <legend>Star Rating</legend>
        <label>
          <input type="radio" name="stars" value="5" />{" "}
          ★★★★★
        </label>
        <label>
          <input type="radio" name="stars" value="4" /> ★★★★
        </label>
        <label>
          <input type="radio" name="stars" value="3" /> ★★★
        </label>
        <label>
          <input type="radio" name="stars" value="2" /> ★★
        </label>
        <label>
          <input type="radio" name="stars" value="1" /> ★
        </label>
      </fieldset>

      <fieldset>
        <legend>Amenities</legend>
        <label>
          <input
            type="checkbox"
            name="amenities"
            value="pool"
          />{" "}
          Pool
        </label>
        <label>
          <input
            type="checkbox"
            name="amenities"
            value="exercise"
          />{" "}
          Exercise Room
        </label>
      </fieldset>
      <button type="submit">Search</button>
    </Form>
  );
}
```

When the user submits this form, the form will be serialized to the URL with something like this, depending on the user's selections:

```
/slc/hotels?sort=price&stars=4&amenities=pool&amenities=exercise
```

You can access those values from the `request.url`

```tsx
<Route
  path="/:city/hotels"
  loader={async ({ request }) => {
    let url = new URL(request.url);
    let sort = url.searchParams.get("sort");
    let stars = url.searchParams.get("stars");
    let amenities = url.searchParams.getAll("amenities");
    return fakeGetHotels({ sort, stars, amenities });
  }}
/>
```

**See also:**

- [useSubmit][usesubmit]

[usenavigation]: ../hooks/use-navigation
[useactiondata]: ../hooks/use-action-data
[formdata]: https://developer.mozilla.org/en-US/docs/Web/API/FormData
[usefetcher]: ../hooks/use-fetcher
[htmlform]: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form
[htmlformaction]: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form#attr-action
[htmlform-method]: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form#attr-method
[urlsearchparams]: https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams
[url]: https://developer.mozilla.org/en-US/docs/Web/API/URL
[usesubmit]: ../hooks/use-submit
[requestmethod]: https://developer.mozilla.org/en-US/docs/Web/API/Request/method
[remix]: https://remix.run
[formvalidation]: https://developer.mozilla.org/en-US/docs/Learn/Forms/Form_validation
[indexsearchparam]: ../guides/index-search-param
