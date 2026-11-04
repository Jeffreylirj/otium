# Configure a job workflow

Use a workflow only for a direct employer form you’ve inspected. Each step identifies a particular control and what appears after it succeeds. Otium does not discover logins, upload endpoints, or intermediate buttons on its own, and this configuration does not imply support for every form on the same hiring platform.

This fictional example shows the shape of a single entry in `jobs.json`. Replace the URL, selectors, and request paths with values you have verified for your form. Omit any steps you do not need.

```json
[
  {
    "id": "example-workflow",
    "url": "https://careers.example.com/candidate/start",
    "credentialEnv": "OTIUM_EXAMPLE",
    "workflow": [
      {
        "type": "login",
        "usernameSelector": "#account-email",
        "passwordSelector": "#account-password",
        "buttonSelector": "#sign-in",
        "successSelector": "#candidate-details",
        "request": {
          "method": "POST",
          "url": "/candidate/login",
          "redirectUrl": "/candidate/details"
        }
      },
      {
        "type": "resume",
        "inputSelector": "#resume-file",
        "successSelector": "#resume-attached",
        "request": { "method": "POST", "url": "/candidate/upload" }
      },
      {
        "type": "next",
        "buttonSelector": "#next-step",
        "successSelector": "#experience-page",
        "request": { "method": "POST", "url": "/candidate/next" }
      }
    ]
  }
]
```

- **Selectors:** Use exact selectors for a single control, preferably stable IDs. The `successSelector` must identify a marker that is hidden or absent before the step and becomes visible after it. Avoid selectors that match controls on multiple pages.
- **`login`:** Must be the first step. It requires a text or email input, a password input, a button labeled **Sign in** or **Log in** (or a supported equivalent), and an approved POST request. If the expected signed-in marker is already visible and the password field is absent or hidden, Otium reuses that session. `credentialEnv` must start with `OTIUM_`, followed by uppercase letters, digits, or underscores. For `OTIUM_EXAMPLE`, Otium reads only `OTIUM_EXAMPLE_EMAIL` and `OTIUM_EXAMPLE_PASSWORD` from the environment of the process that launches it. Supply them through a trusted local credential manager; do not put passwords in `jobs.json`, your profile, or Git.
- **`resume`:** Targets a native file input. Run with `--resume /absolute/path/to/resume.pdf`; the selected file must be a PDF no larger than 10 MB. The same file is used for all configured `resume` steps in the batch. Without a `request`, this step may select the file locally; use a request only when that specific control needs to upload it immediately. Verify the attachment during review.
- **`next`:** Otium fills and scans the current page before continuing, and stops when it finds an unresolved required field. Choose a button labeled **Next**, **Next step**, **Continue**, or **Save and continue**. A JavaScript-only transition can omit `request` if it needs no network calls. A native form or JavaScript action that writes draft progress requires its exact approved POST request. Leave the final application button outside the workflow.

A request is permission to send **one** POST to the exact same-origin URL during that step, with no query or fragment. The endpoint must use a recognized login, upload, or draft-step path for its type; a path such as `/candidate/submit` is rejected. If a native button submits a form, Otium also checks its form action and method. A POST may optionally return a `302` or `303` to the exact same-origin `redirectUrl` you declare; other redirects are blocked. This does not support OAuth or arbitrary navigation. Additional network calls may be blocked while preparing the draft.

```sh
npm start -- --jobs jobs.json --profile profile.json --resume /absolute/path/to/resume.pdf
```

Start with one job and check the report and open tab. If the page doesn’t behave as configured, Otium stops advancing that tab and records a reason for review. An approved write may already have reached the employer even if the expected confirmation didn’t appear. Press Enter in the terminal when ready to enable normal browser interaction, then finish or submit the application manually.
