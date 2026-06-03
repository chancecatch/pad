/* CHANGE NOTE
Why: Preserve richer tutor feedback in saved chat sessions
What changed: Added optional rewrite, fix pairs, fluency, and target phrase feedback fields to chat messages
Behaviour/Assumptions: Existing user/assistant messages remain valid with only role and text
Rollback: git checkout -- src/models/Chat.ts
- mj
*/

import mongoose from "mongoose";

const TutorFixSchema = new mongoose.Schema(
  {
    original: String,
    corrected: String,
    note: String,
  },
  { _id: false }
);

const ChatMessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    text: { type: String, required: true },
    fixes: { type: [TutorFixSchema], default: [] },
    correction: String,
    rewrite: String,
    explanation: String,
    fluencyFeedback: String,
    targetPhraseFeedback: String,
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ChatSessionSchema = new mongoose.Schema(
  {
    title: String,
    clientId: String,
    messages: { type: [ChatMessageSchema], default: [] },
  },
  { timestamps: true }
);

export const ChatSession =
  mongoose.models.ChatSession || mongoose.model("ChatSession", ChatSessionSchema);
