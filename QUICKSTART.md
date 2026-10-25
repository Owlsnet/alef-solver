# Alef Solver: quick start

About five minutes from download to your first answered question.

## 1. Put it in Chrome

1. Get the files: on GitHub press **Code → Download ZIP** and unzip it (or `git clone` the repo).
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Press **Load unpacked** and pick the folder that has `manifest.json` directly inside it. From a downloaded ZIP that is the inner `alef-solver-main` folder, not the outer one.

Each folder you load is its own copy of the extension with its own saved settings. After you change or update the files, press the reload button on the extension's card at `chrome://extensions`, then press F5 on the lesson tab. The popup shows the version (for example `v0.6.28`), so you can tell which copy Chrome is running.

## 2. Give it a key

Click the extension's icon, then **Options…**. Under **Which service answers the questions** pick one. Only the one you pick is used, and each keeps its own key and model.

| Service | Where the key comes from | Default model |
| --- | --- | --- |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys): one key, many models | `deepseek/deepseek-v4.1-flash` |
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `gemini-2.5-flash` |
| OpenAI (ChatGPT models) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `gpt-5-mini` |
| DeepSeek | your own chat.deepseek.com login — no key to buy | `deepseek-chat` |

Paste the key, press **Test key** (you want a green ✓ and the model's one-word reply), then **Save**.

- OpenAI means OpenAI's developer API, which is billed separately. A ChatGPT subscription does not include it, and a ChatGPT login will not work.
- The Model box only suggests names that match what is already typed in it. Clear the box to see the whole list. After Test key works, the list shows the models your key can actually use.
- Graph and picture questions need a model that can read images. If a model cannot, the status line says so and the answer is a guess.

You pay the service you choose, so check its pricing page. The key stays in this browser and is sent to nothing but its own service.

### The DeepSeek option

It uses your own free account on the site instead of a key you buy. Sign in at `chat.deepseek.com` in a tab, then in Options press **Copy token from the site** — it reads your login out of that tab and puts it in the box. Press **Test key**: a green ✓ there means the login is live and the site's anti-bot puzzle was solved. Then **Save**.

Two things to know before you use it:

- **A lesson run is slower on it.** Every question costs about a second of puzzle-solving first, and the two models are `deepseek-chat` (fast) and `deepseek-expert` (slower). DeepThink makes it slower again.
- **It is your own account being used.** The site sees one person answering a lot of questions quickly, which is not what the site is for, and it may not like it. That risk is yours to weigh, and the same login stops working if you sign out on the site.
- **Pictures are not read.** Diagram questions are answered from the text alone, and the status line says when that happened, so pick another service if your work is full of graphs.


## 3. Answer something

Open a question on `moe.alefed.com`, then either press **Ctrl+Shift+S** or open the popup and press **Solve this question**.

To do a whole lesson, press **Solve whole lesson**. It answers, presses Next and carries on until the lesson ends. **Ctrl+Shift+X** (or the Stop button) stops it. All shortcuts can be changed in Options.

The popup's switches:

| Switch | What it does |
| --- | --- |
| Submit automatically | presses Submit after choosing; off leaves the answer for you to submit |
| Screenshot | Auto sends a picture of the page when a figure matters; Never is cheaper, but picture questions become guesses |
| Click Next after each | moves on to the next question |
| Skip questions that offer "I'll try later" | on by default; uses the page's own button instead of answering, which saves time and money |
| Go to the next lesson when done | off by default; after the last question it presses Done, Finish and Back to Coursework, then starts the next lesson on the list, up to the number of lessons set in Options (5 by default) |

If an answer is marked wrong and the page offers Try Again, it tries again with a different answer, up to 3 times by default (also in Options).

## 4. If something goes wrong

Watch the status line at the top right of the lesson page; it says what it is doing and why it stopped.

- **"No API key set"** in the popup: finish step 2.
- **A refused key** (HTTP 401, or "check the key in Options"): the key is wrong or not allowed to use that model. On DeepSeek it means the login has expired — sign in on the site again and press **Copy token from the site**.
- **"Could not see the picture"**: the model cannot read images. Pick one that can in Options.
- **"Could not solve the proof-of-work"** on DeepSeek: the site changed its puzzle. Nothing on your side will fix it; use another service and it can be looked at.
- **An empty reply that ran out of room**: the model thinks too long to answer. Try a different one.
- **Nothing changes after an update**: reload the extension, then F5 the tab, and check the version in the popup.

To send a bug report: in Options switch on **Developer mode** (the extension's own switch, not Chrome's), run it again on the page that failed, open the popup and press **Copy last report**, and paste the result. Look at the `taken` time near the top, to be sure it is a fresh report and not an old one.

A report contains the page's text, the address of your class and lesson (with their ids), and sometimes your name from the page's menu. Read it before you post it anywhere public.

## Before you start

This is an early beta, tested against mock pages modelled on the real layouts, so expect rough edges. The extension answers on your behalf: check that using a tool like this is allowed where you study, because how you use it is up to you.

More detail, including everything it can solve, is in the [README](README.md).
