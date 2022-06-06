---
title: useFormAction
new: true
---

# `useFormAction`

This hook is used internally in [Form] to automatically resolve default and relative actions to the current route in context. While uncommon, you can use it directly to do things like compute the correct action for a `<button formAction>` to change the action of the button's `<Form>`. <small>(Yes, HTML buttons can change the action of their form!)</small>

```tsx
import { useFormAction } from "react-router-dom";

function DeleteButton() {
  return (
    <button
      formAction={useFormAction("destroy")}
      formMethod="post"
    >
      Delete
    </button>
  );
}
```

It's also useful for automatically resolving the action for [`submit`][usesubmit] and [`fetcher.submit`][usefetchersubmit].

```tsx
let submit = useSubmit();
let action = useResolvedAction();
submit(formData, { action });
```

[usesubmit]: ./use-submit
[usefetchersubmit]: ./use-fetcher#fetchersubmit
