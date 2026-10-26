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
| Google Gemini (site login) | your own gemini.google.com login, in an open tab — no key to buy | the account's default |

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

### The Google Gemini option (your own site login)

Same idea as DeepSeek — your own account, no key to buy — but it works differently, and it needs one thing from you:

**Leave a signed-in `gemini.google.com` tab open while the tool answers.** The extension sends its questions from inside that tab, because that is the only place your Google login is valid. It does not copy your cookies or store a password. In Options, press **Test login** and it will tell you whether it found the tab, then fill the model box with the models your account can actually use.

The good news compared with DeepSeek: **it reads pictures**, so diagram questions work, and there is no anti-bot puzzle slowing every question down. Leave the model box on the default unless you have a reason not to — the default is the one model every account has, and some of the others only work on a paid account. **Thinking** (Standard, Low, Medium, Extended) controls how long it reasons before answering: higher is slower and uses the account's allowance faster, so leave it on Standard unless a question needs the extra room. The account's allowance is shared, so a long lesson run can use it up; the status line says so if that happens.

### One chat, not hundreds

On DeepSeek and the Gemini login, every question goes into the same chat instead of starting a new one, so your chat list on those sites stays tidy. The chat remembers the earlier questions, which is usually harmless; to keep it from drifting, a fresh chat is started after 30 questions, and whenever you change the model or the Google account. If you delete the chat on the site, the next question just starts a new one. In Options, **Keep using one chat** turns this off, and **Start a new chat with the next question** ends the current chat on the spot — handy if the answers start to look influenced by earlier questions.
### Faster answers

The status line after each answer says where the time went: `shot` is the screenshot, `setup` is what the service needed before it could be asked (`kept` means it was remembered from the last question), `pic` is uploading the screenshot, and `ai` is the model itself. The biggest part is usually `ai`, which depends on the model you picked: choose a quick one rather than a Pro or thinking one.

Two things you can change. On the Gemini login, **Options → Speed** has the switches for remembering the session between questions and for uploading the screenshot early, plus a table of the last answers' times grouped by which switches were on — answer ten questions with one on and ten with it off, press Refresh, and read the "per question" column. And the popup's **Screenshot → Smart** takes a picture only when the words are not enough, which skips the capture and upload on an ordinary question. It is off unless you choose it. If an answer comes out wrong on a question that needed a picture, put it back on Auto.

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
- **`⏳ … trying again in 0:45` on the status line**: the service is limiting the account, so the tool is waiting for the limit to clear and will ask the same question again by itself — 15 seconds, then 30, a minute, two, three, and then every five minutes. Leave it, or press Stop to cancel. It does not give up on its own, so a limit that lasts for hours (an allowance used up for the day) keeps it asking every five minutes until it goes through.
- **"the Gemini site answered with its own error message"** (or, in an older build, an "unparseable reply" that reads *"I seem to be encountering an error. Can I try something else for you?"*): that sentence is Gemini failing on its side, not a wrong answer. The tool asks again by itself in a fresh session and conversation, and waits a little between tries; only if the site keeps saying it, after about four minutes, does the run stop with a report. If it happens on the same question every time, send the report.
- **"Could not see the picture"**: the model cannot read images. Pick one that can in Options.
- **"Could not solve the proof-of-work"** on DeepSeek: the site changed its puzzle. Nothing on your side will fix it; use another service and it can be looked at.
- **"No signed-in gemini.google.com tab is open"** on the Gemini login option: open that site in a tab, sign in, and leave the tab open. If it is already open, reload it — the extension can only use a tab it has loaded its script into.
- **"the model list did not arrive"** on the Gemini login option: the tab is signed in but the reply was not one the extension could read. The message then describes what did arrive — how many frames came back, which rpc ids they carried and how long the largest part was — which is what tells a changed payload apart from a reply that belongs to a different account. If several Google accounts are signed in on this browser, the extension asks at the tab's own `/u/<n>/` slot, so the open tab must be the account you mean to use; if the message names a slot, that is the login to check. Press **Test login** again after reloading the tab and the extension.
- **An empty reply that ran out of room**: the model thinks too long to answer. Try a different one.
- **Nothing changes after an update**: reload the extension, then F5 the tab, and check the version in the popup.

To send a bug report: in Options switch on **Developer mode** (the extension's own switch, not Chrome's), run it again on the page that failed, open the popup and press **Copy last report**, and paste the result. Look at the `taken` time near the top, to be sure it is a fresh report and not an old one.

A report contains the page's text, the address of your class and lesson (with their ids), and sometimes your name from the page's menu. Read it before you post it anywhere public.

## Before you start

This is an early beta, tested against mock pages modelled on the real layouts, so expect rough edges. The extension answers on your behalf: check that using a tool like this is allowed where you study, because how you use it is up to you.

More detail, including everything it can solve, is in the [README](README.md).
