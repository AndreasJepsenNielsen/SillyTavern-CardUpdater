# Card Updater

A SillyTavern extension that drafts updates to character cards from what has happened in the chat. You review
every section side by side before anything is saved, and the previous version of the card is kept in the chat
so it can be restored.

It works on lorebook entries written in the character card template (all-caps section headings such as
`HISTORY`, `RELATIONSHIPS`, `SPEECH AND VOICE`).

## Install

1. In SillyTavern, open Extensions (the blocks icon) and click **Install extension**.
2. Paste `https://github.com/AndreasJepsenNielsen/SillyTavern-CardUpdater` and install.
3. Reload the page. **Card Updater** is in the right-hand column of the Extensions panel.

Updates: Extensions → **Manage extensions** → the update button next to Card Updater.

## Connection

Pick one under **Connection source**:

- **OpenAI Compatible (direct)**: endpoint URL, API key, model name, max tokens and temperature, like
  Summaryception. On first load the fields are copied from Summaryception's connection if it has one;
  **Copy from Summaryception** does it again. A stronger model than your summarizer is worth it here, since
  updates are rare and need judgement (for example `z-ai/glm-5.3` instead of `z-ai/glm-5.3-flash`).
- **Connection Profile**: any profile from the Connection Manager.
- **The chat's connection**: the model the chat uses.

None of them sends your chat preset's prompts. Max tokens counts the model's thinking too, so keep it high.

**Thinking** (direct connection, sent as OpenRouter's reasoning setting): Medium for reading the story and for the
check pass, High for updating and tightening a card. Low thinking mixed up who did what.

**Model for updating and tightening**: leave empty to use the same model for every step, or put a stronger model
here (for example `z-ai/glm-5.3`) and keep a fast one above for reading the story. A model that can't think "off" (OpenRouter answers "Reasoning is mandatory") gets
Low instead of Off, remembered per model. Temperature defaults to 0.8;
GLM's reasoning models get stuck in loops more easily at low temperatures.

**Loop guard**: if the model's thinking or reply starts repeating itself, the request is stopped right away and
tried once more. Running out of tokens is retried once too. If it still fails, the window shows the error and
the end of the model's thinking.

## Using it

1. Open the chat and click **Update cards…**.
2. Pick the lorebook (the chat's active lorebooks by default) and tick the cards. **Select everyone in the story**
   ticks the cards whose names appear in the story.
3. Tick the sections to update: Identity, Personality, Appearance, History, Knowledge, Secrets, Goals,
   Relationships, Ordinary Day, Social World, Standing. Speech and Voice, sample lines, Limits, Like and Want,
   Fear and Resent, Small Habits and Inner Life are never changed.
4. Under the sections, each ticked card shows what it will read ("reads the whole story: 6 parts, about 22,000
   tokens"). Click **Draft updates**.
5. For each section: green lines are added, red lines removed. Untick what you don't want, or open
   **Edit before saving** to change the text. Then **Save ticked sections**.

## How it reads the story

Each card is done in two steps, so no single request is huge:

1. **The log.** Only the parts of the story that involve the character are read: Summaryception summary lines and
   messages that name them (in the text or in the state block's Physics row), plus your messages right next to
   those. A scene that never names them is something they didn't see. These parts are sent in pieces of about
   6,000 tokens, three at a time, and each comes back as a few dated lines of what the character did, saw, heard
   or was told.
2. **The update.** The card is updated from the new log lines and the tracker rows that name the character,
   not from the raw story.

The log is kept in the chat. Next time only the story after the last read is used, and only log lines that aren't
in the card yet go to the update. If reading fails partway, nothing is added to the log, so the next run starts
from the same place. **Rebuild the ticked cards' logs from the start of the story** starts a card over.

Where the chat has been summarised, the first run uses the Summaryception summary; later runs read the messages
themselves (also the hidden ones) or the summary pieces that cover them.

## What it writes

- Only lasting changes: relationships, where they live and work, what they now know, secrets that came out,
  goals, people who came into or left their life, lasting changes to how they look. Never a passing mood,
  where they are right now or plans for the day.
- Only what that character knows: events they were there for or were told about.
- Everything between the character and your persona goes in their entry for you under RELATIONSHIPS.
- HISTORY keeps every existing line and adds new dated events after them.
- Dates are the story's named days as the chat headers write them. Words that count from a day (yesterday,
  tonight, "four days clean") are flagged.
- PERSONALITY only changes when the story shows a lasting change. Those rows are unticked by default and flagged.
- CANON POINT gets "updated with the story up to [date]" so the card doesn't claim nothing has happened since.

Warnings in yellow: a personality change, history lines removed or rewritten, a relationship entry or sub-section
dropped, or words that count from a day.

## What the updates keep

When lines are written or condensed, props, places and logistics go first. What stays, in order: words either
person said that changed how they stand with each other, in their own words; the character's answer together with
the line it answered (never one without the other); comparisons they draw between your persona and someone else;
their stated stance on what they saw; their own summing-up of the other person or their situation; and anything
another line of the card refers back to. Shortening keeps conditions like "when" and "usually", and explicit facts
are never softened or dropped.

Names: the log names who did what only when the story says it plainly ("unclear who" otherwise), and the update
writes `[check: …]` instead of guessing. The review flags those.

Contradictions: when the story has the character saying or doing something that contradicts a line on the card,
the update changes that line if its section is ticked, or reports it. Reports show at the top of the review under
**Lines that may no longer be true**, to fix by hand.

## The check pass

After each draft (updates and Tighten), one more request reads the old and new text of every changed section next
to the log and the rest of the card, and reports:

- **Lost**: a fact that disappeared although the log doesn't show it stopped being true.
- **Not in the log**: a new statement that neither the log nor the old card supports.
- **Wrong**: something the log contradicts (who did what to whom, the act, dates, a name mix-up).
- **Said twice**: a new fact the card already states elsewhere.

Each finding shows on its section. A section with something lost, unsupported or wrong comes unticked. Separately,
the code flags any added line that is mostly the same words as another line on the card, and says where.
Turn the check off with **Check each draft**.

## Size and Tighten

Anything involving your persona lives only in their entry for you, even when other people were there; an event
with another person who has an entry goes in that person's entry; HISTORY only gets life changes and events with
nobody who has an entry. Lines are edited, not rewritten: a new fact is added to a line, and the line's other facts
stay in their words.

Updates are told the card's size and the **Card size limit** (5,000 tokens by default, the template's limit for a
lead): an update may not take a card over it, and a card that is already over only gets what is essential. They
also say each thing once (anything with your persona only in the entry for you, events in HISTORY, Knowledge only
what isn't already an event) and write one event per line, as one plain sentence.

**Tighten ticked cards** is for a card that has grown too long. It only works on lines that updates added: lines
from the card as it was before its first update in this chat stay word for word. It cuts repeats across sections,
splits crammed lines, rewrites shorthand as plain sentences and keeps each Shared history to the events that
matter most. A change to an original line is flagged and left unticked. Each card's size is shown in the list,
and the review shows the size before and after the ticked changes.

If a card is changed outside Card Updater after it last saved it (by hand, or in another chat), the next run
notices and takes the current text as the card's original, so Tighten leaves those edits alone. Cards updated
before version 0.4.1 count as changed once.

**Tighten: also condense the original card** lets Tighten work on the original lines too: repeats, and old backstory
down to one line per period of the character's life, cutting episodes with side characters who never come up now.
Every change to an original line still arrives flagged and unticked.

## Versions

Every save keeps the card's previous text in the chat file (the last five per card). **Versions…** lists them;
**Restore** puts one back and keeps the version it replaced too. If a card was changed after it was drafted,
saving is refused so nothing is overwritten; draft it again.

## Development

`npm test` runs the logic tests (Node 20 or later).
