# Using Tangent

Tangent has three apps on one sign-in. The **Power | Learn | Canvas** switch (in the power app's sidebar, Learn's header and the canvas bar) moves between them.

- **Power** (`/`): every control. Your own API keys, or Tangent credit where it is sold.
- **Learn** (`/learn/`): a tutor with nothing to configure.
- **Canvas** (`/canvas/`): experimental. Your conversations as lanes on one surface.

Power, Learn and Canvas share one account: a conversation started in one is listed and can be continued in the others. They are views of the same conversations, so a conversation can be opened in any of them: with one open, the switch opens it, on the same thread, in the other app. Learn replies on its one model, Normal: a thread on another provider or model, power's Max included, is answered by Normal there (or the open pool's model), and keeps its own model in power.

Tangent is in beta: a notice at the top of each app asks you to report problems to `admin@` the site's domain. Closing it hides it for a day in that browser.

On an Android phone, Learn and power offer the Android app, Learn made for a phone on the same account, in a notice at the top from your second visit in that browser (the landing page links it too). It shows in place of the beta notice. **Get it on Google Play** opens its store page; following it or closing the notice hides it in that browser for good.

Signing in by email sends one email with a link and a 6-digit code. The link signs you in wherever you open it. Every app also takes the code: type or paste it on the **Check your email** screen, which helps when the email is on another device. Google and GitHub sign you in too, creating your account the first time, as the email does. The phone apps sign in by code, and the Android app also with Google, from the phone's own account picker; the link in the email signs in only a browser. If the app is closed while you read the email, Learn reopens on **Check your email** for that address until the code expires, so you don't need another email. Each works once and expires in 15 minutes; after three wrong codes, ask for a new email. In the web apps, opening a link to a conversation (or any page that needs you signed in) while signed out takes you to sign in and then back to that page, whichever way you sign in, an email link opened in another browser included.

When Tangent is full (a deployment can cap its number of users), the login page still signs existing users in, and offers new people **Join the waitlist**: you get one email when there's room.

## Reply or tangent

Every conversation has a **main thread**, and any message can start a **tangent**: a thread of its own that starts from a message and never writes back into the thread it came from. In Learn a tangent sees everything before it; in power its context mode decides. A tangent can have tangents of its own. (The code and the API call them branches.)

**Reply = the next step. Tangent = a side trip.** If you read the main thread back later, would this exchange belong in the story? If yes, reply; if it would interrupt, go on a tangent. Judge by the thread's topic, not by the last reply: in a lesson on what _e_ is, "Where does that actually come from?" moves the lesson on, while "Wait, what's a limit?" is a detour.

**Not sure? Tangent.** A needless tangent costs nothing: you come back and carry on. A stray reply stays in the main thread, the model reads it on every later turn, and the lesson no longer reads straight through. The loop is: read, go on a tangent for anything confusing or interesting, come back, and reply with what's next. Replies are the next chapter; tangents are footnotes that can grow into books of their own.

- **How tangents work** says this in short: the **?** in Learn's header, **How tangents work** at the foot of the power app's sidebar, the **?** in the Flutter and phone apps' bars, and a card on the landing page (`/welcome#how-tangents`). In the web apps the help links to the keyboard shortcuts, and the `?` key still opens those.
- **The first-run walkthrough:** in Learn (web, Flutter and the phone apps) a new account is walked round the loop once, in three short notes: after the first reply, one at **Tangent ↳**; inside the tangent, one at the way back to the **Main thread**; back on the main thread, one at **Next ➜**, and replying with it (or **Done**) finishes the tour. They never block the page: you move on by using the control they point at. **Skip tour** (or `Esc`) ends it at any step. Finished or skipped, it doesn't come back on any device; **Replay the walkthrough** in the help runs it again. The demos show it on every new visit.

## How Tangent answers

Both apps answer with the same built-in system prompt (in power, unless you set your own): it answers the question asked, directly and in depth, and never quizzes you. Whatever you don't follow, you go on a tangent into. Every substantive reply ends with suggestions in two groups under it:

- **Keep going**: next steps in the thread's topic. Clicking one sends it as your next message in the thread on screen. Only the newest reply of that thread offers them, since the thread has moved past older ones.
- **Suggested tangents**: a term or idea from the reply worth clearing up, or a side topic worth exploring. Clicking one opens a tangent titled after it and asks it. Every reply offers them.

Above them, **Your tangents** lists the tangents you started from that reply, from a suggestion, the message box or a question of your own; clicking one opens it where it starts. The one on the thread you're in, and the one you just came back from, are highlighted. Once a reply has a tangent of yours, its suggestions fold behind one row (**4 suggested tangents**, or **3 more suggested** once you followed one); click it to show them again. Shares and exports list the suggestions as **Keep going** and **Tangents**.

While a reply has no tangent of yours, the Flutter and phone apps show its first suggested tangent with **N more suggested** for the rest. Inside a tangent, its path shows the **Main thread**, the tangent it came from, and **…** for any steps between. The outline (the **Tangents** button on a phone, beside the thread on a wide screen) lists every tangent in the lesson, nested under the one each came from. On a phone the header slides away while you read down and comes back when you scroll up. While the end of a long thread is out of sight, a down-arrow button above the message box jumps to it; tapping the lesson title (or, in a tangent, its name in the path) goes back to the thread's start, as does tapping the status bar on an iPhone. On a keyboard, `Home` and `End` do the same while you aren't typing.

**Diagrams.** When a picture would make an answer clearer, the tutor offers a specific one in its last sentence (say, a sequence diagram of a handshake); ask, and it draws it in the reply once the reply has finished. On the web, **Show source** shows the text behind it. A diagram that can't be drawn shows that text, with a note; share links and exports always show the text.

**Checking facts.** On Tangent credit, and on OpenRouter or Anthropic with your own key, a reply can search the web when it likely needs to: deep in a tangent, a specific fact, something recent, or when you ask for sources. A grounded reply cites its claims as links and lists its sources ("Checked against 3 sources"). An unchecked one says "From the tutor's own knowledge", with a **Check sources** button that searches and adds a corrected, cited answer. The open pool never searches.

## The power app

- **Replying** in the message box (**Send**, whose tooltip reads **Next ➜**) continues the thread on screen. Anything new is meant to be a tangent, a click away.
- **Ask about this:** select text in a finished message and **Ask about this** appears above the message box. It opens a tangent quoting the selection, with the box focused for your question (nothing is sent until you send it). Its gear (**More**) opens **Tangent from here** with the quote filled in. Selecting and pressing `b` opens that dialog too.
- **Tangent ↳**, on any message, opens **Tangent from here**: quote highlighted text, write a starting message (`Ctrl`/`Cmd+Enter` creates and asks), pick a context mode, provider and model. By default a tangent inherits its parent's. There is no title field: a tangent is named after its first reply; rename it in **Tangent settings** or in the outline.
- **Context modes** decide what the model sees in a tangent:
  - `path`: everything its parent saw, plus the tangent's own messages;
  - `summary`: a summary of the parent's conversation;
  - `message`: only the message the tangent starts from, plus the quote;
  - `independent`: only the quote or topic.
- **Ask your own question…** ends every finished reply's suggestions, after **Keep going** and **Suggested tangents**, and stays in view when they fold. On the newest reply it is already open, without taking focus. Enter asks in a new `path` tangent (Shift+Enter for a new line, Escape folds it); its gear opens **Tangent from here** with the question.
- **Your tangents** under a message lists the tangents started from it, each with its context mode and message count. Breadcrumbs and **↩ Parent message** go back to the exact message a tangent started from.
- **Deleting a tangent**, with everything below it, after a confirmation: the trash beside it under a message's **Your tangents**, beside **↩ Parent message**, in the outline or in **Tangent settings**. Conversations delete from the home page and the sidebar.
- **Context Inspector** (`i`): exactly what the next message will send, and why: inherited messages, summaries, the quote, and what was compacted or dropped.
- **Review up to here** (on any reply, or `v`): sends the conversation, as the model saw it, to a reviewer model (default in **Settings**). The review lists corrections and says whether to continue on a stronger model; one click moves the thread to the reviewer's model, starts a tangent on it, or puts the corrections in the message box. Reviews aren't stored.
- **Normal | Max and Compare:** a switch in the bar under the message box picks the suggested models; **Compare** asks both and lets you keep one answer. Only the answer you keep enters the conversation, and both are paid for.
- **The bar under the message box** shows the thread's route (provider, who pays, model) and opens its settings. If the thread is on your own key and this browser has no key for it, it says so before you send, with **Use Tangent credit** and **Add your key**.
- **Links between messages:** **Link…** on any message (or `l`) links it to another message of the conversation, with an optional note: search or browse, or **Pick on the page instead**. Linked messages show **N related** chips at both ends; a chip opens the other end, with a **Back to ‘…’** pill. Links aren't sent to the model.
- **Text size:** **Aa** in the chat header (85% to 140%), or `-`, `+` and `0` outside a text field. It applies to the messages and the message box, and is saved in this browser; Learn and Canvas have their own.
- **Settings** (sidebar): your default system prompt in power and Canvas, used by every conversation without a prompt of its own, including ones you started before you changed it (saved to your account; Learn's lessons keep the tutor prompt; **Use default** starts from the built-in one, and an empty box means the built-in one), and, saved in this browser, the default reviewer, the Normal and Max models, **Reply length** and **Input limit**. The input limit caps how much of a conversation each message sends (16,000 to 128,000 tokens, or a custom number); over it, the oldest messages are summarized (the default) or dropped. As you edit it, it shows what that means in words, pages and, where the price is known, dollars.
- **Conversation settings:** the conversation's own system prompt and title. Leave the prompt empty, or clear it, and the conversation follows your default system prompt, whatever it is when you send.
- **Private tangents** (a tangent setting) are left out of every share and export, with everything below them.
- **Sharing:** **Share…** in the chat header picks a scope (the whole conversation, a tangent and everything below it, or one path), with an optional title and expiry. A link shows the conversation as it was when shared; later messages reach it only when you republish it. The dialog first lists the links the conversation already has. The **Shares** page lists every link; republish a link in place or revoke it, which takes effect at once. A shared page is kept out of search engines, labels messages "User" and "AI", and tells readers the replies are AI-generated. Until the operator turns sharing on for everyone, **Share…** appears only for allowed accounts. A new account can publish links after its first day, and each account can create 20 links a day; deleting a link doesn't give it back, and a publish the screening refuses uses one up too. What a link publishes (a new link, a republish or a new title) is screened automatically first; a conversation the screening flags can't be shared, and the app says only that. Every shared page has a **Report this conversation** link, for anyone who opens it, signed in or not; a report may take the link down while it is reviewed. A link taken down shows as **unavailable** on the Shares page, and the only thing left to do with it is delete it.
- **Export:** Markdown, or one offline HTML file with the same viewer as share links.
- **Backup:** **Export → JSON backup (everything)** includes everything, private tangents and links too. **Import** restores it as a new conversation. Files over 10 MB, Markdown or HTML exports and other JSON are refused with a message saying why.
- **Keys & credit** (sidebar): your own provider keys, and where credit is sold the balance and **Add credit**. **Billing** (`/billing`): the membership, balance, top-ups and recent usage. To add credit, pick an amount or type your own: the page shows the credit, the service fee on it and the subtotal before tax, and **Add credit** opens the secure checkout, where tax is added. You get the full amount of credit, and each reply takes its model's list price from it.

### Keyboard shortcuts

| Keys              | Action                                                   |
| ----------------- | -------------------------------------------------------- |
| `Alt+↑` or `[`    | Parent thread (where this tangent started)               |
| `Alt+←` / `Alt+→` | Previous / next tangent                                  |
| `Alt+↓` or `]`    | First tangent from here                                  |
| `j` / `k`         | Next / previous message                                  |
| `b`               | Tangent from the focused message                         |
| `v`               | Review up to the focused (or latest) reply               |
| `l`               | Link the focused (or latest) message to another          |
| `/`               | Focus the message box                                    |
| `i`               | Context Inspector                                        |
| `+` / `-`         | Larger / smaller conversation text                       |
| `0`               | Reset the text size                                      |
| `?`               | Show all shortcuts                                       |
| `Esc`             | Close dialogs and panels, stop picking a message to link |

### Without a membership

Where the operator charges a membership, replies on your own keys need one. Without it, nothing is locked away: conversations stay listed, readable, exportable and manageable. A thread on your own key shows a notice where the message box was: **Renew membership** (or **Become a member**), **Open in Learn** (the same conversation in Learn, where the open pool or Tangent credit can reply), and, while credit can pay, **Continue with Tangent credit**, which moves that thread onto credit. Its replies' suggested tangents fold behind one row, since none can start there; your tangents under them still open.

## Learn

Learn keeps only the essentials:

- a list of lessons, with **Import** above it and **Export** (the download icon) on each lesson;
- a chat on one model, Normal, with no model to pick;
- the tutor's **Keep going** and **Suggested tangents** under each reply, below **Your tangents** ([How Tangent answers](#how-tangent-answers));
- two buttons under the message box after a reply: **Tangent ↳** ("Wait, what's that?") sends your message as a new tangent from that reply, and **Next ➜** ("Got it, what's next?") sends it as the next message of the thread you're in, the main thread or, inside a tangent, that tangent. Their tooltips (a long press in the Flutter and phone apps) say when to pick each. `Enter` sends as a tangent and `Ctrl`/`Cmd+Enter` as Next (`Shift+Enter` for a new line). With nothing to go on a tangent from (a new lesson, a reply that failed, a tangent with no message yet) there is just **Send**. The box grows to three lines while you type in it. The Flutter and phone apps work the same way;
- **Ask about this** on selected text (above the message box on the web, in the selection menu in the Flutter and phone apps) puts the words on the message box ("Ask about this…"). Your next message asks about them in a new tangent, which shows the quote under its title, so only **Tangent ↳** shows; **×** takes them off;
- **Connect** on a message: link it to a related message of the lesson, with an optional note; both then list it under **Connected to N**;
- finding your way: a tangent opens at its first message. Inside one, the path (**Main thread** › … › here) returns to the message it started from; **Main thread** goes back to the lesson's main thread. On a phone the path shows its start and its last steps. The **sidebar** (the menu button on a phone) lists your lessons, and under the open one the main thread and every tangent in it, nested under the one each came from; delete a lesson or tangent from its trash. Click a message to mark it (the URL then points at it). On a keyboard: `Alt`+arrows or `[` / `]` between tangents, `j` / `k` between messages, `/` the message box, `?` lists them all;
- **How tangents work** (the **?** in the header) and the first-run walkthrough ([Reply or tangent](#reply-or-tangent));
- deleting a tangent with everything below it (the trash beside it under **Your tangents**, or beside it in the sidebar);
- **Aa** for the lesson's text size;
- **Your instructions** (the pencil in a lesson's header, while replies are paid with your own key or credit): instructions of your own for that lesson, such as "Answer in French", added after the tutor's. The open pool ignores them, and so does power;
- **How replies are paid for** (account menu): your own OpenRouter key, **Tangent credit** (prepaid; the header shows the balance), or the **open pool** (free within daily limits, while it has credit). Where the membership is required, your own key needs it; credit and the pool never do. A message refused for want of a key, credit or membership is kept and sent once you pick a way on. The Flutter and phone apps have the same dialog in their account menu, and a refused message stays in the message box with **How you pay**, to send again once you pick; they keep the key encrypted (on a phone, in its keychain) and send members to the web for the membership and credit;
- **Billing** (`/learn/billing`): the membership, and with credit the balance, top-ups (as in power) and recent usage.
- **Delete account** (account menu, here and in the Flutter and phone apps, or `/learn/delete-account` as a page of its own): deletes the account all three apps share, once you retype your email. The public `/delete-account` page says what is deleted and kept, and its button signs you in and opens that page.

An import into Learn is adapted so it can be continued there: threads on a provider or model Learn doesn't offer move to Normal, and every tangent gets the whole path as context. Learn answers with its tutor prompt whatever prompt the conversation had in power mode. Nothing is charged by an import.

## Canvas (experimental)

A view of the same conversations: anything started in power or Learn opens on the canvas and the other way round.

- **Every thread is a lane** on one pannable, zoomable surface, a tangent's lane hanging to the right of the message it starts from. The curve's stroke shows its context mode (solid `path`, dashed `summary`, dash-dot `message`, dotted `independent`).
- **Every lane has its own message box and streams on its own;** the bar counts how many are writing.
- **Tangent from here, in variants:** the tangent button opens one lane or several at once, each with its own mode and model, and an optional starting message sent to all of them ("Every context mode" asks the same question three ways).
- **Keep going**, **Suggested tangents**, **Ask your own** and **Ask about this** work as in power: Keep going (on the selected lane's last reply) sends the lane's next message, and the others open new lanes. The lanes started from a card show on it as chips, under **Your tangents**.
- **Lineage:** with a lane selected, the cards the model would see light up; summarized and dropped ones are marked.
- **Fold** a lane's subtree into a capsule; a minimap and keyboard navigation (`?` lists it) cover the rest.
- **Links** across lanes: drag the port on a card's edge onto another card, or press `r` for pick mode.
- **Delete** a lane with every lane below it from the trash in its head.
- **Aa** in the bar sets the cards' text size (`+`, `-` and `0` zoom the canvas).

There is no reviewer, share, export or settings editor on the canvas; use the power app for those.

## The demos

`/learn/demo`, `/demo` and `/canvas/demo` run the apps entirely in the browser: no sign-in, no model calls, and nothing kept after the tab closes. Replies are random English sentences, but tangents, suggestions, "Ask about this", Check sources (on pretend sources), export and import behave as in the real app.
