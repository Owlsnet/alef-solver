# Alef Solver

A Chrome extension that reads the question on the page, asks an AI model, and answers it.

This is a very early beta version. It will be improved in the future.

## What it can solve

- Multiple choice, with or without a reading passage (a screenshot is sent when a figure matters)
- Select all that apply ("Select the correct answers"), ticking every right card; formulas on the cards are read from the page's own MathML copy, so a power or a bracket is not lost
- Fill in the blank, typed answers with or without a word bank
- Typed maths, in the answer boxes that have a keyboard icon (powers, roots and fractions as plain text such as x^2)
- Drop-down, choosing from menus inside a sentence
- Matching, linking items in two columns
- Drag and drop, dragging answers into the gaps of a sentence
- Ordering, dragging a list of items into the right order

It reads English and Arabic lessons. It can answer one question or run a whole lesson, pressing Next until the lesson ends. Screens with no question on them, such as a picture to explore or text to read, are skipped with Next in a lesson run, unless something on them wants an answer. Any question that offers the page's own "I'll try later" button (listening questions, some writing ones) is skipped with it rather than answered, which saves tokens and time; that can be switched off in the popup. If an answer is marked wrong and the page offers Try Again, it tries again with a different answer, up to three times by default.

With "Go to the next lesson when done" switched on in the popup (off by default), a run also presses Done after the last question, then the results page's Finish, then Submit, then Back to Coursework, then Start on the next task in the list, up to the number of lessons set in Options (five by default). On the task list it takes the first lesson that says Start or Continue (a lesson already begun is picked up where it was left), in the list's order. If the task list still shows a lesson that was just finished and the Start opens it again, it notices from the lesson id in the address, goes back, and takes the next one. A run started on the task list itself starts the first task it can do. This step has only been tried on a mock course so far.

A lesson picked up part-way can open on a question that was already answered wrongly and is showing Try Again, even a drop-down that holds its old answer; the run presses Try Again and answers it again, telling the model what was marked wrong. When it presses an answer card it aims where a person's press would land (the picture or text under the middle of the card, never the magnifier), and if the page does not show the card as chosen it tries the card itself, its tick mark, the control inside it, the Space key and a plain click, one after another; a failure report lists which of these it tried and how the card looked.

These types were built and tested against mock pages modelled on the real layouts. The live site may differ, so expect rough edges.

## Install

1. Open `chrome://extensions` and turn on Developer mode.
2. Click Load unpacked and select this folder.
3. Open the extension's Options, paste an [OpenRouter](https://openrouter.ai/keys) API key, click Test key, then Save.

The key is stored in your browser only and is sent to nothing but openrouter.ai. The default model is `deepseek/deepseek-v4.1-flash`.

## Use

Open a question on `moe.alefed.com`, then either:

- press `Ctrl+Shift+S` to solve the question, or
- open the popup and press Solve this question or Solve whole lesson.

`Ctrl+Shift+X` stops a lesson run. All shortcuts can be changed to any key in Options.

## Settings

Options holds the API key, the model and a fallback model, the delays between steps, how many times to try again after a wrong answer, how many lessons to do per run, the shortcuts, and Developer mode. The popup has toggles for submitting automatically, opening a reading passage first, screenshots, reusing the passage across a lesson, clicking Next, and going on to the next lesson.

## When it breaks

The site's markup can change. Turn on Developer mode in Options, run it on the page that failed, then click Copy last report in the popup and paste the result into an issue.

## Development

There is no build step. The tests drive headless Chrome and need Node 24 and Chrome installed:

    node tools/test-drag.js

There is one `tools/test-*.js` file per area (parsers, lessons, each question type, retries, shortcuts, the popup).

---

luv from owls <3
