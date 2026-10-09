# Using Tangent

Tangent has three apps on one sign-in. The **Power | Learn | Canvas** switch (in the power app's sidebar, Learn's header and the canvas bar) moves between them.

- **Power** (`/`): every control. Your own API keys, or Tangent credit where it is sold.
- **Learn** (`/learn/`): a tutor with nothing to configure.
- **Canvas** (`/canvas/`): experimental. The power app's conversations as lanes on one surface.

Power and Canvas share one account; Learn has its own, so power conversations and Learn lessons are kept apart. To move one across, export its JSON backup in one app and import it in the other, or use **Create a copy in Learn**.

## How Tangent answers

New conversations in both apps start with the same built-in system prompt: it answers the question asked, directly and in depth, and never quizzes you. Whatever you don't follow, you branch into. Every substantive reply ends with two to four suggested **tangents** (shown as buttons under the reply, **Where next?**); clicking one opens a branch titled after it and asks it.

**Checking facts.** On Tangent credit, and on OpenRouter or Anthropic with your own key, a reply can search the web when it likely needs to: deep in a tangent, a specific fact, something recent, or when you ask for sources. A grounded reply cites its claims as links and lists its sources ("Checked against 3 sources"). An unchecked one says "From the tutor's own knowledge", with a **Check sources** button that searches and adds a corrected, cited answer. The open pool never searches.

## The power app

- **Replying** in the message box continues the current branch ("Continue this thread…"). Anything new is meant to be a branch, a click away.
- **Ask about this:** select text in a finished message and **Ask about this** appears above the message box. It opens a branch quoting the selection, with the box focused for your question (nothing is sent until you send it). Its gear (**More**) opens **Branch from here** with the quote filled in. Selecting and pressing `b` opens that dialog too.
- **Branch from here**, on any message: quote highlighted text, write a starting message (`Ctrl`/`Cmd+Enter` creates and asks), pick a context mode, provider and model. By default a branch inherits its parent's. There is no title field: a branch is named after its first reply; rename it in **Branch settings** or in the outline.
- **Context modes** decide what the model sees in a branch:
  - `path`: everything its parent saw, plus the branch's own messages;
  - `summary`: a summary of the parent's conversation;
  - `message`: only the message the branch forks from, plus the quote;
  - `independent`: only the quote or topic.
- **Ask your own question…** ends every finished reply's **Where next?** list. On the newest reply it is already open, without taking focus. Enter asks in a new `path` branch (Shift+Enter for a new line, Escape folds it); its gear opens **Branch from here** with the question.
- **"N branches"** under a message lists its children. Breadcrumbs and **↩ Parent message** go back to the exact branch point.
- **Deleting a branch**, with everything below it, after a confirmation: the trash beside a branch in a message's branch list, beside **↩ Parent message**, in the outline or in **Branch settings**. Conversations delete from the home page and the sidebar.
- **Context Inspector** (`i`): exactly what the next message will send, and why: inherited messages, summaries, the quote, and what was compacted or dropped.
- **Review up to here** (on any reply, or `v`): sends the conversation, as the model saw it, to a reviewer model (default in **Settings**). The review lists corrections and says whether to continue on a stronger model; one click moves the branch to the reviewer's model, branches off on it, or puts the corrections in the message box. Reviews aren't stored.
- **Normal | Max and Compare:** a switch in the bar under the message box picks the suggested models; **Compare** asks both and lets you keep one answer. Only the answer you keep enters the conversation, and both are paid for.
- **The bar under the message box** shows the branch's route (provider, who pays, model) and opens its settings. If the branch is on your own key and this browser has no key for it, it says so before you send, with **Use Tangent credit** and **Add your key**.
- **Links between messages:** **Link…** on any message (or `l`) links it to another message of the conversation, with an optional note: search or browse, or **Pick on the page instead**. Linked messages show **N related** chips at both ends; a chip opens the other end, with a **Back to ‘…’** pill. Links aren't sent to the model.
- **Text size:** **Aa** in the chat header (85% to 140%), or `-`, `+` and `0` outside a text field. It applies to the messages and the message box, and is saved in this browser; Learn and Canvas have their own.
- **Settings** (sidebar): your default system prompt for new conversations (saved to your account; **Use default** starts from the built-in one), and, saved in this browser, the default reviewer, the Normal and Max models, **Reply length** and **Input limit**. The input limit caps how much of a conversation each message sends (16,000 to 128,000 tokens, or a custom number); over it, the oldest messages are summarized (the default) or dropped. As you edit it, it shows what that means in words, pages and, where the price is known, dollars.
- **Conversation settings:** the conversation's own system prompt (clear it for none) and title.
- **Private branches** (a branch setting) are left out of every share and export, with everything below them.
- **Sharing:** **Share…** in the chat header picks a scope (the whole tree, a subtree or one path) and a mode (a frozen snapshot or live), with an optional title and expiry. The dialog first lists the links the conversation already has. The **Shares** page lists every link; republish a snapshot in place or revoke a link, which takes effect at once. Until the operator turns sharing on for everyone, **Share…** appears only for allowed accounts.
- **Export:** Markdown, or one offline HTML file with the same viewer as share links.
- **Backup:** **Export → JSON backup (everything)** includes everything, private branches and links too. **Import** restores it as a new conversation. Files over 10 MB, Markdown or HTML exports and other JSON are refused with a message saying why.
- **Keys & credit** (sidebar): your own provider keys, and where credit is sold the balance and **Add credit**. **Billing** (`/billing`): the membership, balance, top-ups and recent usage.

### Keyboard shortcuts

| Keys              | Action                                                   |
| ----------------- | -------------------------------------------------------- |
| `Alt+↑` or `[`    | Parent branch (at the branch point)                      |
| `Alt+←` / `Alt+→` | Previous / next sibling branch                           |
| `Alt+↓` or `]`    | First child branch                                       |
| `j` / `k`         | Next / previous message                                  |
| `b`               | Branch from the focused message                          |
| `v`               | Review up to the focused (or latest) reply               |
| `l`               | Link the focused (or latest) message to another          |
| `/`               | Focus the message box                                    |
| `i`               | Context Inspector                                        |
| `+` / `-`         | Larger / smaller conversation text                       |
| `0`               | Reset the text size                                      |
| `?`               | Show all shortcuts                                       |
| `Esc`             | Close dialogs and panels, stop picking a message to link |

### Without a membership

Where the operator charges a membership, replies on your own keys need one. Without it, nothing is locked away: conversations stay listed, readable, exportable and manageable. A branch on your own key shows a notice where the message box was: **Renew membership** (or **Become a member**), **Create a copy in Learn** (a free copy of the conversation in Learn), and, while credit can pay, **Continue with Tangent credit**, which moves that branch onto credit.

## Learn

Learn keeps only the essentials:

- a list of lessons, with **Import** above it and **Export** (the download icon) on each lesson;
- a chat with a **Normal | Max** toggle (while Max is on, a note says about how many times as much it uses) and **Compare** next to Send: Normal and Max both answer, side by side on a wide screen; only the answer you keep enters the lesson;
- **Ask about this** on selected text, the tutor's suggested tangents under each reply, and **Ask your own question…** after them (a side question that starts with it). The message box reads "Continue this lesson…";
- **Connect** on a message: link it to a related message of the lesson, with an optional note; both then list it under **Connected to N**;
- deleting a side question with everything below it (the trash beside it, or beside **Back to…** while it is open);
- **Aa** for the lesson's text size;
- **How replies are paid for** (account menu): your own OpenRouter key, **Tangent credit** (prepaid; the header shows the balance), or the **open pool** (free within daily limits, while it has credit). Where the membership is required, your own key needs it; credit and the pool never do. A message refused for want of a key, credit or membership is kept and sent once you pick a way on;
- **Billing** (`/learn/billing`): the membership, and with credit the balance, top-ups and recent usage.

An import into Learn is adapted so it can be continued there: branches on a provider or model Learn doesn't offer move to Normal, every side question gets the whole path as context, and the lesson gets Learn's tutor prompt. Nothing is charged by an import.

## Canvas (experimental)

A view of the power app's conversations: anything started in power opens on the canvas and the other way round.

- **Every branch is a lane** on one pannable, zoomable surface, hanging to the right of the message it forks from. The curve's stroke shows its context mode (solid `path`, dashed `summary`, dash-dot `message`, dotted `independent`).
- **Every lane has its own message box and streams on its own;** the bar counts how many are writing.
- **Branch into variants:** the branch button opens one lane or several at once, each with its own mode and model, and an optional starting message sent to all of them ("Every context mode" asks the same question three ways).
- **Ask your own** and **Ask about this** work as in power, opening new lanes.
- **Lineage:** with a lane selected, the cards the model would see light up; summarized and dropped ones are marked.
- **Fold** a lane's subtree into a capsule; a minimap and keyboard navigation (`?` lists it) cover the rest.
- **Links** across lanes: drag the port on a card's edge onto another card, or press `r` for pick mode.
- **Delete** a lane with every lane below it from the trash in its head.
- **Aa** in the bar sets the cards' text size (`+`, `-` and `0` zoom the canvas).

There is no reviewer, share, export or settings editor on the canvas; use the power app for those.

## The demos

`/learn/demo`, `/demo` and `/canvas/demo` run the apps entirely in the browser: no sign-in, no model calls, and nothing kept after the tab closes. Replies are random English sentences, but branching, tangents, "Ask about this", Check sources (on pretend sources), export and import behave as in the real app.
