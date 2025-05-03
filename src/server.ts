import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { StreamChat } from "stream-chat";
import axios from "axios"; // Import axios for sending requests
import { db } from "./config/database.js";
import { chats, users } from "./db/schema.js";
import { eq } from "drizzle-orm";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://ai-chat-frontend.onrender.com",
      "https://ai-chat-85xc.vercel.app",
    ],
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Initialize Stream Client
if (!process.env.STREAM_API_KEY || !process.env.STREAM_API_SECRET) {
  throw new Error("Missing Stream API credentials in environment variables.");
}

const chatClient = StreamChat.getInstance(
  process.env.STREAM_API_KEY,
  process.env.STREAM_API_SECRET
);

// Register user with stream chat
app.post(
  "/register-user",
  async (req: Request, res: Response): Promise<any> => {
    const { name, email } = req.body || {};

    if (!name || !email) {
      return res
        .status(400)
        .json({ error: "Please fill all the required fields" });
    }

    const userId = email.replace(/[^a-zA-Z0-9_-]/g, "_");

    try {
      // Check if user exists
      const userResponse = await chatClient.queryUsers({ id: { $eq: userId } });

      if (!userResponse.users.length) {
        // Add new user to the stream
        await chatClient.upsertUser({
          id: userId,
          name: name,
          email: email,
          role: "user",
        });
      }

      // check for existing users in the database
      const existingUser = await db
        .select()
        .from(users)
        .where(eq(users.userId, userId));

      if (!existingUser.length) {
        console.log(
          `User ${userId} does not exists in the db! ADDING THEM NOW...`
        );
        await db.insert(users).values({ userId, name, email });
      }

      res.status(200).json({ userId, name, email });
    } catch (error: any) {
      console.error("Error when registering:", error.message);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// Function to clean up AI response
const cleanResponse = (text: string): string => {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1") // Remove ** for bold text
    .replace(/\*(.*?)\*/g, "$1") // Remove * for italic text
    .replace(/`(.*?)`/g, "$1") // Remove ` for code
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1") // Remove markdown links
    .replace(/#{1,6}\s/g, "") // Remove markdown headers
    .replace(/>\s/g, "") // Remove blockquotes
    .replace(/---/g, "") // Remove horizontal rules
    .trim(); // Remove extra whitespace
};

// Send Message to Gemini
app.post("/chat", async (req: Request, res: Response): Promise<any> => {
  const { message, userId } = req.body;

  if (!message || !userId) {
    return res.status(400).json({ error: "Message and user are required" });
  }

  try {
    // Verifying the user exists
    const userResponse = await chatClient.queryUsers({ id: userId });

    if (!userResponse.users.length) {
      return res
        .status(404)
        .json({ error: "User not found. Please register and try again." });
    }

    // Check user in database

    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.userId, userId));

    if (!existingUser.length) {
      return res
        .status(404)
        .json({ error: "User not found please register and try again" });
    }

    //fetch users past messages for context

    const chatHistory = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, userId))
      .orderBy(chats.createdAt)
      .limit(10);

    // format the chat history for gemini ai
    const conversation = chatHistory
      .map((chat) => ({
        role: "user",
        parts: [{ text: chat.message }],
      }))
      .concat({
        role: "model",
        parts: [{ text: chatHistory[chatHistory.length - 1]?.reply || "" }],
      });

    // Make the request to the Gemini API
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          ...conversation,
          {
            role: "user",
            parts: [{ text: message }],
          },
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // Extract just the text from the Gemini response to avoid circular references
    let aiReplyText = "No response generated";

    if (
      geminiResponse.data &&
      geminiResponse.data.candidates &&
      geminiResponse.data.candidates[0] &&
      geminiResponse.data.candidates[0].content &&
      geminiResponse.data.candidates[0].content.parts &&
      geminiResponse.data.candidates[0].content.parts[0] &&
      geminiResponse.data.candidates[0].content.parts[0].text
    ) {
      aiReplyText = geminiResponse.data.candidates[0].content.parts[0].text;
    }

    // save the chat to db

    await db.insert(chats).values({ userId, message, reply: aiReplyText });

    // Create or get the channel
    const channel = chatClient.channel("messaging", `chat-${userId}`, {
      name: "AI CHAT",
      created_by_id: "ai_bot",
    });

    await channel.create();
    await channel.sendMessage({ text: message, user_id: "ai_bot" });

    // Send the response from Gemini back to the user
    res.status(200).json({ reply: aiReplyText });
  } catch (error: any) {
    console.error("Error when sending message to Gemini:", error.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET chat history for a user

app.post("/get-messages", async (req: Request, res: Response): Promise<any> => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required to continue" });
  }

  try {
    const chatHistory = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, userId));

    res.status(200).json({ messages: chatHistory });
  } catch (error: any) {
    console.log("Error fetching chat history", error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server is running at port: ${PORT}`);
});
