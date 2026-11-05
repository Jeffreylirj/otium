# Scope and known gaps

Otium’s first milestone is to take a list of application pages, fill fields using answers you supplied, and hand the open tabs back to you. A prefilled form is a draft. It may disappear when you close or reload the page, and the employer may validate fields differently when you submit. Review the values and the full form before sending anything.

## What Otium leaves to you

- Verify the employer and posting before giving a page access to personal information. Use links you trust and review any sign-in requests directly in the browser.
- Review employer-specific questions, declarations, sensitive fields, and fields with ambiguous labels. An unknown answer is a gap, not an invitation to guess. A field left untouched might already contain a value supplied by the page or browser; review it anyway.
- Handle verification challenges, single sign-on, cross-origin transitions, and any pages the runner cannot reach or understand. [Configured workflows](workflows.md) can handle an explicitly configured same-origin sign-in, native PDF input, or draft progression. There is no automatic discovery of these actions. Generic autofill supports grouped radio questions, exact Boolean checkboxes and existing ARIA listbox options; unsupported widgets and sensitive declarations remain manual.
- Confirm the meaning of each configured request before using it. The runner validates the URL and control and checks the observed result, but it cannot prove what the employer’s server does with a request. A timed-out or blocked transition is not proof that an approved request had no effect. Inspect the current draft before retrying.
- Click the final submission control yourself. Once you press Enter in the terminal, the runner removes its temporary restrictions, so a page may begin sending or autosaving answers even before you submit. Closing the bot or its browser is not a durable save.

Use direct employer form links. The CLI rejects LinkedIn, Handshake, and common Workday application domains. [LinkedIn prohibits unauthorized automation](https://www.linkedin.com/help/linkedin/answer/a1341543), and [Handshake’s external apply flow can involve its own questions and application state](https://support.joinhandshake.com/hc/en-us/articles/360043604173-Jobs-Apply-Externally).

## Coverage and evidence

The common-structure engine adds semantic labels, autocomplete tokens, known placeholder hints, group-level radios, confirmed checkboxes, existing accessible listbox options, bounded discovery of dependent fields, and visible same-origin frames. The synthetic common-controls fixture reaches 7 of 8 required questions (87.5%); certification is deliberately left for review. A dependent-field fixture reaches 2 of 2. These measurements describe those fixtures only.

The local interface runs the same browser engine. Its demo uses two local forms with synthetic answers and intentionally unresolved questions. The UI browser test verifies both application results, explicit manual handoff, batch closure, and rejected requests from the wrong origin or without the session token. The server binds to 127.0.0.1; this interface is not the older hosted Trajectory dashboard.

The November 5 regression run passed all 17 tests in isolated Chrome, including the interface demo, common controls, same-origin frames, conditional fields, earlier sign-in/upload workflows, and the manual submission boundary.

“90% filled” is a target for supported forms, not a guarantee across employers. For a meaningful coverage number, count required fields Otium correctly filled and verified against **all** required fields the applicant had to answer, including those on later pages. Report unsupported pages, wrong values, unknown answers, and manual steps separately. A percentage from only the fields a runner recognized can hide substantial work.

The current report’s coverage counts visible, enabled required fields that appear filled and pass browser validation, including any preexisting answers, on the pages actually scanned. It excludes hidden or unvisited steps, unsupported form structures, and fields the site did not mark as required. Review the separate list of answers Otium actually filled. A `review` result means the form was scanned and is available to check. `blocked` means Otium reached a manual boundary such as a sign-in or verification prompt, a required gap, or a workflow transition it could not verify. `error` means a job could not be prepared; inspect its tab manually.

Local tests can establish behavior on controlled forms, including whether a submit handler was triggered. They cannot prove that every real hiring site behaves the same way. A live pilot should use explicitly approved postings, a small batch, and manual inspection of every draft. Record the hiring platform, failure category, and label or control type, with personal values removed.

In the initial nine-test Chrome suite, the mixed form fixture ended with 6 of 9 visible required fields filled; the three remaining prompts asked for compensation, work authorization, and certification. The suite checked that tabs remain open, unapproved fixture attempts to submit or send requests are blocked during preparation, the human can submit after handoff, one failed page does not stop the batch, and confirmed answers are reused. It also verified that an answer altered by page code after autofill is flagged for review.

The first fixture run caught two field-matching bugs: a wrapping label included its select’s option text, and a LinkedIn URL field had a label spelling the matcher missed. Both were corrected and are covered by the fixture. The local Playwright browser cache did not match the installed dependency, so verification used the installed Chrome channel.

The expanded Chrome suite passed 13 tests, including native sign-in with a session cookie, JavaScript sign-in and progression, a synthetic PDF upload, stopping on unresolved required fields, blocking credential replay on a cross-origin redirect, and rejecting a submission URL labeled as Next.

On November 4, 2026, the runner scanned public forms from [IMC on Greenhouse](https://job-boards.greenhouse.io/imc/jobs/4823924101), [Belvedere Trading on Lever](https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0/apply), and [Notion on Ashby](https://jobs.ashbyhq.com/notion/2b587e66-deac-421a-a824-9415ba78b5a7/application) with an empty profile and no application actions. Ashby needed two pinned read queries to load its public form; a change to those queries may block future scans until reviewed. These checks verified public form access only. The research pass also found a live [Dow Jones Workday posting](https://dowjones.wd1.myworkdayjobs.com/en-US/Dow_Jones_Career/job/Summer-2027-Internship-Program---Software-Engineering-Intern_Job_Req_55891), but did not go past the public application entry panel.

## What to improve after the first pilot

1. Expand coverage using redacted fixtures for real failure patterns: customized forms, dependent fields, repeatable education and work sections, and multi-page flows.
2. Improve reporting when pages are closed, blocked, slow, or unexpectedly redirect. Keep one difficult application from holding up the queue.
3. Make it easier to turn unresolved report entries into the confirmed-answer file. The current `learn` command requires explicit answers typed into that file, and never harvests answers from browser tabs.
4. Add a durable handoff for longer runs. A browser tab is useful for immediate review but cannot guarantee draft recovery after a reboot or page timeout.

Automatic listing discovery and employer integrations are outside this milestone. Keep employer accounts, applicant profiles, review reports, and screenshots out of shared source control.

## Product research

- [Simplify Copilot](https://help.simplify.jobs/help/articles/2415391-use-copilot-to-autofill-applications) is the benchmark for supported multi-page forms, reusable answers, and manual review. Its separate [Autopilot](https://help.simplify.jobs/en/help/articles/1784339-get-started-with-autopilot) already handles a batch of selected jobs and submits supported applications. Otium’s intended workflow is to prepare a batch while preserving a review step for every application.
- [Jobright](https://jobright.ai/tools/ai-job-apply) also distinguishes its application agent from its browser autofill tool. The useful pattern for Otium is unattended preparation plus a clear handoff for unresolved fields.
- The public [Greenhouse job board API](https://docs.greenhouse.io/job-board.html#retrieve-a-job) can expose a posting’s questions without using its separate authenticated submission endpoint. [Lever](https://github.com/lever/postings-api) and [Ashby](https://developers.ashbyhq.com/docs/public-job-posting-api) can provide application URLs; a public posting feed does not make every employer’s form uniform. Treat ATS support as unverified until representative forms are tested.
