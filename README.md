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

None of them sends your chat preset's prompts. The request holds the card, the story and the update instructions.
Reasoning models need room to think: if replies come back empty, raise **Max tokens**.

## Using it

1. Open the chat and click **Update cards…**.
2. Pick the lorebook (the chat's active lorebooks by default) and tick the cards. **Select everyone in the story**
   ticks the cards whose names appear in the story text.
3. Tick the sections to update: Identity, Personality, Appearance, History, Knowledge, Secrets, Goals,
   Relationships, Ordinary Day, Social World, Standing. Speech and Voice, sample lines, Limits, Like and Want,
   Fear and Resent, Small Habits and Inner Life are never changed.
4. Click **Draft updates**. Cards are drafted one at a time; each shows up for review when it is done.
5. For each section: green lines are added, red lines removed. Untick what you don't want, or open
   **Edit before saving** to change the text. Then **Save ticked sections**.

What the model reads: the Summaryception summary (if the chat has one), the chat after it, and the trackers
from the latest state block. Without a summary it reads the last 60 messages (setting).

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

## Versions

Every save keeps the card's previous text in the chat file (the last five per card). **Versions…** lists them;
**Restore** puts one back and keeps the version it replaced too. If a card was changed after it was drafted,
saving is refused so nothing is overwritten; draft it again.

## Development

`npm test` runs the logic tests (Node 20 or later).
