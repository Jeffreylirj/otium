# Otium

Otium is a local browser runner for preparing a batch of job applications. Give it a list of direct application URLs and the profile answers you’re willing to share. It opens a tab per job, fills fields it recognizes, and produces a review report. You complete the missing fields, check the answers, and submit each application yourself.

## Run a batch

For an easier way to test, launch the local interface:

```sh
npm ci
npm run ui
```

The interface uses your existing Google Chrome profile. The first time, open `chrome://extensions` in regular Chrome, enable Developer mode, choose **Load unpacked**, and select this repository’s `extension` folder. Open **Otium Chrome Companion** from the Extensions menu and click **Connect this Chrome**. Chrome asks for optional site access so the companion can fill application forms; the workers only run in tabs Otium opens for your batch. Reload the Otium page in regular Chrome if it was already open.

Open **http://127.0.0.1:4317** and click **Try demo**. Otium opens two synthetic applications in your normal Chrome window, fills the sample profile, and shows a checklist. No employer receives the demo data. Click **Enable manual review** to unlock the tabs, then **Close batch** when finished.

To use your own links, enter your details and paste one direct application URL per line. **Prepare applications** sends a batch to the connected Chrome companion; the interface does not launch a separate browser. The extension reuses the existing session and can fill a visible form or stage a PDF in a clearly labeled native résumé input. Verify the attachment. Sign-in, additional pages, and application submission stay manual in regular Chrome. Explicit sign-in, upload and progression workflows remain available in the separate CLI runner below. Keep the terminal running. Press Ctrl+C to stop the interface.

The shared autofill engine supports labeled inputs, native dropdowns, standard autocomplete hints, recognized placeholder hints, grouped radio questions, confirmed Boolean checkboxes, exact existing ARIA listbox options, dependent fields, and visible same-origin embedded forms. See [form support research](docs/form-support.md) for tested patterns and the remaining gaps.

Install Node.js 22 or later, then install the dependencies and Chromium:

```sh
npm ci
npx playwright install chromium
```

If Google Chrome is already installed, you can skip the Chromium download and add `--channel chrome` to the batch command below. Otium still uses its own browser profile.

Copy [jobs.example.json](jobs.example.json) to `jobs.json` and [profile.example.json](profile.example.json) to `profile.json`, then replace the sample values. Use 1–50 openings and give each a unique ID (letters, numbers, `.`, `_`, or `-`) and a direct HTTPS link to a verified employer application form. The runner skips repeated URLs:

```json
[
  { "id": "example-swe", "url": "https://careers.example.com/apply/123" },
  {
    "id": "example-data",
    "url": "https://jobs.example.org/application/456",
    "answers": { "Why this team?": "I’d like to work on the data quality tooling described in the posting." }
  }
]
```

Create `profile.json` with only information you want the runner to use. Use the question’s label for a reusable custom answer. A job’s optional `answers` object takes priority for that job, so an employer-specific answer won’t carry over to other applications. Sensitive questions such as work authorization, sponsorship, consent, and demographic information remain manual even if you include an answer:

```json
{
  "answers": {
    "firstName": "Alex",
    "lastName": "Example",
    "email": "alex@example.com",
    "phone": "4155550100",
    "city": "San Francisco",
    "state": "California",
    "country": "United States",
    "university": "Example University",
    "major": "Computer Science"
  },
  "customAnswers": {
    "Are you available for a summer internship?": "Yes"
  }
}
```

Run Otium from a terminal on a machine with a desktop session:

```sh
npm start -- --jobs jobs.json --profile profile.json --out review --session .otium-browser --concurrency 2
```

Keep the machine awake and leave the terminal and browser open. Otium uses a dedicated browser profile and prepares up to two jobs at a time in this example (`--concurrency` accepts 1–5). Use separate session folders for concurrent batches.

When the batch finishes, Otium prints the path to `review/<run-id>/report.html`. The same timestamped folder contains `report.json`. The report lists fields filled, fields still needing attention, and the completion rate for visible required fields. Check the report and then **press Enter in the terminal** to enable normal browser interaction. Review each original tab, finish the remaining fields and attachments, and submit yourself. Press `Ctrl+C` after you finish; closing the browser can discard drafts. Use `--headless` for a report only; it closes the browser when the run ends.

## Configure a site-specific workflow

Without a workflow, Otium fills the current page and stops. For a form you’ve inspected, you can explicitly configure up to 12 `login`, `resume`, and `next` steps for that job. See [workflow setup and example](docs/workflows.md) for the selectors, credential environment variables, optional `--resume` path, and the exact requests each step can make. Configured steps may sign in, attach your selected PDF, or save draft progress before you review the application. Final submission remains manual.

## Teach Otium a confirmed answer

Put confirmed, reusable answers in `confirmed.json`, with each question’s label as a key and a string or Boolean as its value. See [confirmed.example.json](confirmed.example.json) for an example:

```json
{ "Are you available for a summer internship?": "Yes" }
```

```sh
npm start -- learn --profile profile.json --confirmed confirmed.json
```

This updates the profile’s local `customAnswers` for future runs. It replaces an existing answer for the same question; it does not capture browser input automatically. Keep answers specific to one employer in that job’s `answers` object. The learner rejects sensitive question categories reserved for manual review.

## Working with real applications

- Start with a small batch of pages you trust. Use direct form links and expect to handle sign-in, verification, and unfamiliar controls yourself.
- Supply only accurate answers. Add recurring answers to your local profile after you’ve confirmed them, and use employer-specific answers only on the intended application.
- Treat your profile, Chromium session folder, resume, and review reports as private. Never commit them. The session folder can contain sign-in cookies, and the profile can contain personal information.
- No one has established a 90% fill rate on real employer sites yet. See [known gaps](docs/limitations.md) for what the current prototype can and cannot validate.

## Development

To test the actual Chrome extension with a disposable profile, install the Playwright Chromium build and run:

```sh
OTIUM_TEST_CHROME_EXTENSION=1 node --test test/chrome-companion.test.mjs
```

```sh
npm test
```

Run `OTIUM_TEST_CHANNEL=chrome npm test` to use installed Google Chrome. Use controlled fixtures for development and testing; don’t run automated tests against real employer application forms.
