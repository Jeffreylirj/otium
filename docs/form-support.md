# Applicant form support plan

Research checked November 5, 2026. This document distinguishes documented patterns, observed public forms, and recommended implementation work. Vendor coverage claims and an ATS hostname do not establish that Otium can prepare every employer's application. No measured market-share or universal completion percentage is asserted.

## What existing autofill tools establish

[Simplify Copilot](https://help.simplify.jobs/help/articles/2415391-use-copilot-to-autofill-applications) combines saved profile answers, selected documents, reusable answers to matching questions, and supported multipage filling. Its manual flow ends in the employer's review and Submit action. Otium's useful goal is preparing a chosen batch and preserving each application for review, with a consolidated list of missing answers. [Simplify's installation guide](https://help.simplify.jobs/help/articles/1749022-install-and-set-up-copilot) warns that particular employer forms can differ even on a supported ATS.

Useful open-source approaches, reviewed as references rather than installed dependencies:

- [Job App Filler](https://github.com/berellevy/job_app_filler#project-layout) describes site-specific input classes, rescanning when the DOM changes, answers scoped by page/section/type/name, and framework-specific change/blur handling. This supports an adapter architecture with one common field model. A visible value alone does not establish that a controlled component accepted it. The repository identifies a BSD-3-Clause license; review its terms if reusing source.
- [OpenJobAutofill](https://github.com/Br1an67/OpenJobAutofill/blob/main/README.en.md) documents local rule matching, optional AI for field-to-profile-name mapping, and explicit pending fields. Otium can adopt that separation: infer a field's meaning, then retrieve a user-confirmed value. The project identifies an MIT license. Its support claims have not been independently tested here.
- [ApplyAI](https://github.com/muhammad-saadd/applyai#known-limitations) lists SPA navigation, controlled inputs, employer customization, and file handling among its limitations. Its model-driven answer generation is a different trust model from using confirmed values. No source has been copied into Otium.

## Recurring structures and implementation order

Implemented in this iteration: native semantic inputs and selects, grouped radio questions, confirmed Boolean checkboxes, exact existing ARIA listbox options, dependent-control discovery, and visible same-origin embedded forms. The local interface and its two-form demo use the same engine. Dates with separate month/year controls, repeating employment records, remote-search widgets, shadow-root label resolution, and generic ATS workflow discovery remain future work; the priority table below includes those research recommendations as well as implemented patterns.

These priorities follow the forms observed and the technical difficulty, not an estimate of how many applications each platform serves.

| Priority | Structure | Proposed behavior and acceptance evidence |
| --- | --- | --- |
| P0 | Labeled native inputs, textareas, and native selects | Resolve unambiguous labels and standard autocomplete tokens; use supplied values; check value and browser validity after blur. Preserve prefilled answers and report them separately. |
| P0 | Native radio groups and checkbox groups | Capture the group question and all option labels. Match the confirmed answer to exact options. Count a radio group as one question, rather than counting every radio as a separate requirement. Leave sensitive declarations manual. |
| P0 | Dynamically revealed dependent questions | Rescan after an accepted fill; stop at a bounded stable state. Test a Yes answer that reveals another required field. Do not claim completion from the initial DOM alone. |
| P1 | ARIA comboboxes, listboxes, searchable locations/schools | Open a recognized widget, inspect visible options, select an exact known value, verify selected state. Avoid treating arbitrary text in the search box as a completed choice. |
| P1 | Date controls and split graduation dates | Normalize only explicitly recognized formats; handle month/year/date separately. Reject an unrepresentable value rather than silently dropping a component. |
| P1 | Repeating employment and education sections | Scope each field to its section and record index; distinguish a current-employment checkbox from other Yes/No fields. Test multiple records before allowing automatic Add actions. |
| P1 | Resume attachment and resume parsing | Require an explicitly chosen local file and configured workflow. Verify the accepted attachment or parser result. A file chooser value does not establish that upload succeeded. |
| P2 | Login, draft saving, and multiple pages | Use explicit site workflows and bounded transitions. Verify the expected next page and record skipped or blocked steps. Distinguish draft progression from submission. |
| P2 | Iframes, shadow DOM, and tenant-specific widgets | Add an adapter only with a redacted fixture and a known review boundary. Report inaccessible frames and unvisited pages. |

[MDN's autocomplete reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/autocomplete) supplies useful hints such as given-name, family-name, email, tel, and address fields. A hint is evidence about meaning, not permission to override a contradictory question. [Playwright's actions documentation](https://playwright.dev/docs/input) distinguishes text fill, option selection, checked state, and file input operations; each needs its own post-action check.

## ATS-specific evidence

| Platform | Evidence and recurring boundaries |
| --- | --- |
| Greenhouse | The [Job Board API](https://docs.greenhouse.io/job-board.html#retrieve-a-job) exposes questions, field types, choices, and required flags using `questions=true`. Questions can contain multiple alternative controls, such as a resume file or text. Public reads and authenticated submission are separate. The [IMC internship form](https://job-boards.greenhouse.io/imc/jobs/4823924101) inspected November 4 had custom country, city, and education controls alongside native text and attachment fields. |
| Lever | The [official postings API](https://github.com/lever/postings-api) exposes hosted apply URLs but states that custom questions are not exposed by the public posting feed. Form requirements vary by employer. The [Belvedere Trading form](https://jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0/apply) inspected November 4 showed contact details, resume, and custom questions on a public form. |
| Ashby | The [public feed](https://developers.ashbyhq.com/docs/public-job-posting-api) provides apply URLs; the actual JavaScript application needs inspection. The [Notion mobile internship application](https://jobs.ashbyhq.com/notion/2b587e66-deac-421a-a824-9415ba78b5a7/application), inspected read-only November 4, required group-level answers for location preferences, degree, and mobile platform plus a searchable location, graduation date, experience essay, and resume. Authorization, sponsorship, and demographic prompts require manual review under Otium's current policy. |
| Workday | [Employer instructions](https://hr.wisc.edu/hr-guides/for-hr-professionals/apply-for-jobs-at-uw-madison-as-an-external-applicant/) show sign-in, information, experience, questions, disclosures, and review steps. The [Dow Jones public entry point](https://dowjones.wd1.myworkdayjobs.com/en-US/Dow_Jones_Career/job/Summer-2027-Internship-Program---Software-Engineering-Intern_Job_Req_55891) inspected November 4 offered resume autofill, manual apply, and reuse. No authenticated pages were traversed. Do not label this as tested Workday autofill support. |

The public examples are dated observations; postings can close or change. The research did not enter applicant values, upload documents, sign in, or submit applications.

## Completion and missing-answer contract

Report required *questions*, accepted values, prefilled values, unresolved questions, and unvisited steps separately. Keep source question text, section, control type, reason for stopping, and the selected profile key; redact personal values from shared diagnostics. Group validation and employer-required markers matter as well as native `required` attributes.

For a supported form, coverage should mean correctly filled and verified required questions divided by every required question discovered across all visited steps. Mark coverage incomplete when steps remain unvisited. A local fixture score is evidence for that fixture only. A 90% target requires a representative, explicitly approved live pilot and manual verification of correctness, not simply a count of nonempty boxes.

Learning must take explicit confirmed answers, with employer-specific essays stored per job. Reusing a global answer because option text says Yes is unsafe: the group question may ask a different thing. Unknown questions, incompatible options, authentication/verification, legal statements, and unsupported controls need distinct report reasons.

Do not promise that open tabs survive page reload, machine sleep, a process crash, or session expiry. A [dedicated Playwright persistent profile](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context) preserves session data, not every site's live form state. Resume uploads and draft save requests may already transmit applicant data before final submission, so configured workflows must disclose those actions.

## Suggested regression set

Use synthetic forms and values for repeatable tests: paired hidden/visible controls; duplicate option text across separate questions; native and ARIA choice groups; dynamic conditional fields; controlled input reset after blur; invalid date/select values; prefilled fields; two education/work records; delayed loading; a removed input; an iframe; attempted autosubmit; a login/OTP boundary; and one failed job in a batch. Include explicit assertions for the manual final submission boundary and for every unsupported field appearing in the report.
