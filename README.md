# Card Updater

A SillyTavern extension that drafts updates to character cards from what has happened in the chat. Updates come
as a list of changes to single lines, each checked against the story; you tick the ones you want before anything is
saved, and the previous version of the card is kept in the chat so it can be restored.

It works on lorebook entries written in the character card template (all-caps section headings such as
`HISTORY`, `RELATIONSHIPS`, `SPEECH AND VOICE`).

## Install

1. In SillyTavern, open Extensions (the blocks icon) and click **Install extension**.
2. Paste `https://github.com/AndreasJepsenNielsen/SillyTavern-CardUpdater` and install.
3. Reload the page. **Card Updater** is in the right-hand column of the Extensions panel.

Updates: Extensions → **Manage extensions** → the update button next to Card Updater, then reload the page. The
version number shows next to the name in the settings and in the update window, so you can see which one runs.

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
check pass, High for updating, fixing and tightening a card. Low thinking mixed up who did what.

**Model for updating and tightening** (also used for fixing): leave empty to use the same model for every step, or put a stronger model
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
5. Each change is its own row, grouped by section and relationship entry: the line it changes with the changed
   words marked (red out, green in), the line it adds and where, or the line it removes. Each row says why, and
   what the check found. Untick what you don't want, or open **Edit before saving** to change the text. Then
   **Save ticked changes**. **Mark log lines as done without saving** skips those log lines next time.

## How it reads the story

Each card is done in two steps, so no single request is huge:

1. **The log.** Only the parts of the story that involve the character are read: Summaryception summary lines and
   messages that name them (in the text or in the state block's Physics row), plus your messages right next to
   those. A scene that never names them is something they didn't see. These parts are sent in pieces of about
   6,000 tokens, three at a time, and each comes back as a few dated lines of what the character did, saw, heard
   or was told.
2. **The update.** The model gets the card with numbered lines, the new log lines and the tracker rows that name
   the character (not the raw story), and returns a list of changes: change line N (quoting just the words to
   change in a long line), add a line after line N, or remove line N. Every line it doesn't name stays exactly as
   it is. Clock times are taken out of the log lines first (the date is enough), and lines the log model ran
   together are split.

The log is kept in the chat. Next time only the story after the last read is used, and only log lines that aren't
in the card yet go to the update. If reading fails partway, nothing is added to the log, so the next run starts
from the same place. **Rebuild the ticked cards' logs from the start of the story** starts a card over.
**Update from the ticked cards' whole log again** is for a card you restored or edited by hand: the update uses
every logged line, also the ones already marked as done, without reading the story again.

Where the chat has been summarised, the first run uses the Summaryception summary; later runs read the messages
themselves (also the hidden ones) or the summary pieces that cover them.

## What it writes

- Only lasting changes: relationships, where they live and work, what they now know, secrets that came out,
  goals, people who came into or left their life, lasting changes to how they look. Never a passing mood,
  where they are right now or plans for the day.
- Only what that character knows: events they were there for or were told about.
- Everything between the character and your persona goes in their entry for you under RELATIONSHIPS.
- Existing lines are never rewritten as a whole section; a long line is changed by quoting only the words that
  change, so the rest of the line stays word for word.
- Dates are the story's named days as the chat headers write them. Words that count from a day (yesterday,
  tonight, "four days clean") are flagged.
- PERSONALITY only changes when the story shows a lasting change. Those rows are unticked by default and flagged.
- CANON POINT gets "updated with the story up to [date]" so the card doesn't claim nothing has happened since.

Warnings in yellow, about what the change itself adds (never about what the line already said):

- a personality change (unticked);
- anything involving your persona added to HISTORY or KNOWLEDGE (unticked: it belongs in their entry for you);
- a change outside the sections you ticked (unticked);
- a clock time, or words that count from a day;
- what an edit cuts from its line ("Cuts from the line: …"), or names and numbers it no longer has;
- a new line over 50 words, or a line that grows a lot;
- a new line that is mostly the same words as another line of the card, with that line's closest sentence;
- a line number that was off by one and was moved to the line it plainly fits.

## What the updates keep

When lines are written or condensed, props, places and logistics go first. What stays, in order: words either
person said that changed how they stand with each other, in their own words; the character's answer together with
the line it answered (never one without the other); comparisons they draw between your persona and someone else;
their stated stance on what they saw; their own summing-up of the other person or their situation; and anything
another line of the card refers back to. Shortening keeps conditions like "when" and "usually", and explicit facts
are never softened or dropped.

Secrets and knowledge: a secret counts as out only when the story shows that exact fact told or seen (crying in
front of someone doesn't tell them about an earlier time she cried), and a change to who it's hidden from has to
agree with that person's Hides line. A Knows line holds what the character found out; what they told someone is an
event. A line of wants, likes or knowledge grows: the new part is added and the old parts stay unless the story
ended them. How your persona looks or what they wear is never written into a card, since the story may have made
it up. A day gets at most two new Shared history lines of about 40 words.

Names: the log names who did what only when the story says it plainly ("unclear who" otherwise), and the update
writes `[check: …]` instead of guessing. The review flags those.

Contradictions: when the story has the character saying or doing something that contradicts a line on the card,
the update changes that line if its section is ticked, or reports it. Reports show at the top of the review under
**Lines that may no longer be true**, to fix by hand.

## The check pass and the fix

After each draft, one more request reads every change next to the numbered card, the log and the tracker rows, and
reports:

- **Lost**: a fact the change drops although the log doesn't show it stopped being true.
- **Not in the log**: something neither the log nor the card supports (an added cause, reason or detail).
- **Wrong**: something the log or another line of the card contradicts (who did what to whom, the act, the order,
  dates, a name mix-up).
- **Said twice**: something the card or another change already says the same way. The same event told from two
  people's entries, or a secret in SECRETS and in a Hides line, is not a repeat.
- **Passing state**: a mood, where someone is right now, what they did that day.

It also reads the whole card against the log and lists lines that are no longer true and that no change covers
(a "she has none" the story has ended, a rule that was broken).

Then the fix step: the flagged changes and the outdated lines in the ticked sections go back to the updating model
once, with what the check found. For each flagged change it sends a corrected version, drops it, or keeps it and
says why the check is wrong; for each outdated line it sends a change. The corrected and new changes are checked
once more. The review says what happened ("Fix: 3 fixed, 1 dropped, 2 outdated lines changed"), and a change
that still has a problem comes unticked, with the problem shown. Dropped changes are listed at the bottom.
Outdated lines nothing covers, and lines in sections you didn't tick, show at the top under **Lines that may no
longer be true**.

Turn these off with **Check each draft** and **Fix what the check finds**. Tighten drafts get the check without
the fix.

## Size and Tighten

Anything involving your persona lives only in their entry for you, even when other people were there; an event
with another person who has an entry goes in that person's entry; HISTORY only gets life changes and events with
nobody who has an entry.

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
