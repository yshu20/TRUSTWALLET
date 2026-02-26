import type { Express } from "express";
import { createApp } from "../server/app.js";

let appPromise: Promise<Express> | null = null;

async function getApp() {
  if (!appPromise) {
    try {
      console.log("Initializing app...");
      appPromise = createApp();
      const app = await appPromise;
      console.log("App initialization successful");
      return app;
    } catch (err: any) {
      console.error("App initialization failed:", err);
      appPromise = null; // Reset for next attempt
      throw err;
    }
  }

  return appPromise;
}

export default async function handler(req: any, res: any) {
  try {
    if (!process.env.DATABASE_URL) {
      return res.status(500).json({
        error: "Configuration Error",
        message: "DATABASE_URL is missing in environment variables"
      });
    }

    const app = await getApp();
    return app(req, res);
  } catch (err: any) {
    console.error("Vercel Handler Error:", err);
    return res.status(500).json({
      error: "Initialization Error",
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
  }
}
