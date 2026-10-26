# Alef Solver

A Chrome extension that reads the question on the page, asks an AI model, and answers it.

This is a very early beta version. It will be improved in the future.

New here? Start with the [quick start guide](QUICKSTART.md).

## What it can solve

- Multiple choice, with or without a reading passage (a screenshot is sent when a figure matters)
- Select all that apply ("Select the correct answers"), ticking every right card; formulas on the cards are read from the page's own MathML copy, so a power or a bracket is not lost. Some pages take only as many ticks as there are right answers and quietly ignore the rest without saying how many; when a tick is refused, the tool works out the number from what the page kept, asks the model again for exactly that many, and switches off a wrong tick before switching on a new one. The other way round, when every tick is in but Submit stays switched off because the page wants more of them, it asks again for at least one more (twice at most, then it stops and says why)
- Fill in the blank, typed answers with or without a word bank
- Typed maths, in the answer boxes that have a keyboard icon (powers, roots and fractions as plain text such as x^2)
- Drop-down, choosing from menus inside a sentence
- Matching, linking items in two columns
- Drag and drop, dragging answers into the gaps of a sentence
- Ordering, dragging a list of items into the right order

It reads English and Arabic lessons. It can answer one question or run a whole lesson, pressing Next until the lesson ends (some lessons put up the next question by themselves after Submit, with no Next button; the run notices that and carries on). Screens with no question on them, such as a picture to explore or text to read, are skipped with Next in a lesson run, unless something on them wants an answer. Any question that offers the page's own "I'll try later" button (listening questions, some writing ones) is skipped with it rather than answered, which saves tokens and time; that can be switched off in the popup. If an answer is marked wrong and the page offers Try Again, it tries again with a different answer, up to three times by default.

With "Go to the next lesson when done" switched on in the popup (off by default), a run also presses Done after the last question, then the results page's Finish, then Submit, then Back to Coursework, then Start on the next task in the list, up to the number of lessons set in Options (five by default). On the task list it takes the first lesson that says Start or Continue (a lesson already begun is picked up where it was left), in the list's order. If the task list still shows a lesson that was just finished and the Start opens it again, it notices from the lesson id in the address, goes back, and takes the next one. A run started on the task list itself starts the first task it can do. This step has only been tried on a mock course so far.

A lesson picked up part-way can open on a question that was already answered wrongly and is showing Try Again, even a drop-down that holds its old answer; the run presses Try Again and answers it again, telling the model what was marked wrong. When it presses an answer card it aims where a person's press would land (the picture or text under the middle of the card, never the magnifier), and if the page does not show the card as chosen it tries the card itself, its tick mark, the control inside it, the Space key and a plain click, one after another; a failure report lists which of these it tried and how the card looked.

These types were built and tested against mock pages modelled on the real layouts. The live site may differ, so expect rough edges.

## Install

1. Open `chrome://extensions` and turn on Developer mode.
2. Click Load unpacked and select this folder.
3. Open the extension's Options, choose which service answers the questions, paste its key, click Test key, then Save.

Three services are supported, and only the one chosen in Options is used:

- **OpenRouter** (the default): one key from [openrouter.ai/keys](https://openrouter.ai/keys), many models. The default model is `deepseek/deepseek-v4.1-flash`.
- **Google Gemini**: your own key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey), called directly. The default model is `gemini-2.5-flash`. After Test key works, the model box offers exactly the Gemini models that key can use. Check Google's own pages for what a model costs and what the limits are.
- **OpenAI** (the ChatGPT models): an API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys), called directly. This is OpenAI's developer API, billed on its own; a ChatGPT subscription does not include it and a ChatGPT login does not work. The default model is `gpt-5-mini`, and Test key fills the model box with the chat models that key can use.
- **DeepSeek** (your own account on the site, no key to buy): sign in at `chat.deepseek.com`, then in Options press "Copy token from the site" — it reads your login out of that tab. Test key proves the login is live and that the site's anti-bot puzzle is being solved. The models are `deepseek-chat` (fast) and `deepseek-expert` (slower); DeepThink and web search are switches, not models. The site's chat takes no pictures, so diagram questions are answered from the text alone and the answer is marked when that happened. See the quick start for what this costs you in time and risk.
- **Google Gemini** (your own gemini.google.com login, no key to buy): leave a signed-in gemini.google.com tab open, and the extension sends its questions from that tab. Nothing is copied and no password is stored. It reads pictures, so diagram questions work. Press Test login in Options to fill the model box with the models your account can actually use, and to choose a thinking level (standard, low, medium or extended). The tab must stay open; that is the one practical catch. If more than one Google account is signed in, the tab you leave open decides which one is used — the extension asks at that tab's own `/u/<n>/` slot rather than at the bare address, which would be answered for whichever account the browser treats as default.

**One chat, not hundreds** (DeepSeek and the Gemini login): these two sites list every conversation in a sidebar, so by default the questions all go into a single chat rather than a new one each. Only the ids that let the site find that chat again are kept in the browser. The chat does remember the earlier questions, so a new one is started after 30 questions and whenever the model or the Google account changes, and if the chat has been deleted from the site the question is asked again in a fresh one. "Keep using one chat" in Options turns this off; "Start a new chat with the next question" ends the current one at once.

**Speed.** Every answer's status line ends with where its time went — `shot` (capturing the page), `setup` (what the service needed before it could be asked; marked `kept` when it was remembered from the last question), `pic` (the screenshot upload) and `ai` (the model). With the Gemini login, the session and the model list are remembered for ten minutes instead of being fetched before every question (and fetched again at once if the site refuses them), and the screenshot is uploaded while the model list loads. Options → Speed has a switch for each, and a table averaging the last 60 answers grouped by which switches were on, so a change can be judged by numbers. The popup's Screenshot setting also has **Smart**, which takes a picture only when the words are not enough — a figure, an empty question, picture answers, a question that names a graph, table or diagram, or one that names a passage that was not read — and goes without for an ordinary question. It is the fastest mode and is off unless chosen; the default is still Auto.

**Rate limits are waited out.** When a service says it is limiting the account — an HTTP 429 from any of them, or one of the Gemini site's "not now" codes (1037 the allowance is used up, 1013 a temporary error, 1060 the network address is blocked for a while, and 1095, which no documentation explains and is treated the same way) — the question is not given up on. The status line shows `⏳ … trying again in 0:15 (Stop cancels)` and counts down, then asks the same question again, waiting 15 seconds, then 30, a minute, two, three, and then five minutes each time, or exactly as long as the service said when it said (never more than ten minutes). It goes on until the question goes through or Stop is pressed, which cancels the wait within a second, without a failure report. OpenAI saying the account's money has run out is not treated as a wait, since waiting does not cure that; neither is anything that is not a rate limit — a refused key or login, or a model that no longer matches, still ends the run with a report as before.

Each service keeps its own key, model and fallback model, so switching back and forth loses nothing. A key is stored in your browser only and is sent to nothing but its own service: openrouter.ai, generativelanguage.googleapis.com (in a request header, never in the address), api.openai.com, chat.deepseek.com, or — for the Gemini login — gemini.google.com itself, from inside your own tab. If Google or OpenAI refuses the key, the run stops at once and says so, since no other model would be allowed either. A model that uses its whole budget thinking and writes no answer is asked once more with more room, its extended thinking switched off (OpenRouter's reasoning setting; for OpenAI's reasoning models, low effort; for DeepSeek, DeepThink off; for the Gemini login, the site's low level) and a note to answer at once; if the service will not switch thinking off, it is asked for less of it; if that fails too, the next model on the list is tried rather than the same one again. A model that keeps thinking itself out of room anyway is the wrong choice for this job: pick a different one in Options.

## Use

Open a question on `moe.alefed.com`, then either:

- press `Ctrl+Shift+S` to solve the question, or
- open the popup and press Solve this question or Solve whole lesson.

`Ctrl+Shift+X` stops a lesson run. All shortcuts can be changed to any key in Options.

## Settings

Options holds the API key, the model and a fallback model, the delays between steps, how many times to try again after a wrong answer, how many lessons to do per run (100 unless changed), the shortcuts, and Developer mode. The popup has toggles for submitting automatically, opening a reading passage first, screenshots, reusing the passage across a lesson, clicking Next, and going on to the next lesson.

## When it breaks

The site's markup can change. Turn on Developer mode in Options, run it on the page that failed, then click Copy last report in the popup and paste the result into an issue.

## Development

There is no build step. The tests drive headless Chrome and need Node 24 and Chrome installed:

    node tools/test-drag.js

There is one `tools/test-*.js` file per area (parsers, lessons, each question type, retries, shortcuts, the popup, the Options page, and the answering services: `tools/test-gemini.js` runs the real service worker against a scripted network and needs no browser, no key and no call to Google or DeepSeek). `tools/test-gemini-web.js` runs the script that lives inside a Gemini tab against a scripted page and stream, checking the session values read out of the page, the account slot every request is made at, the model list and account tier, the request body and model header, the length-prefixed reply frames, and the two ways a refusal comes back (a bare code, and a `BardErrorInfo` block). `tools/test-deepseek-pow.js` checks the DeepSeek proof-of-work digest against published SHA3-256 vectors and against Node's own SHA3-256 at every length, and `tools/test-load.js` checks the manifest, the header-rewrite rules and that the service worker starts — it loads the folder into headless Chrome, which Chrome 137 and later may refuse to do from the command line, in which case that part is reported as skipped rather than passed.

Nothing here talks to the real DeepSeek or Gemini site: that needs your login, so it is what Test key in Options is for.

---

luv from owls <3
