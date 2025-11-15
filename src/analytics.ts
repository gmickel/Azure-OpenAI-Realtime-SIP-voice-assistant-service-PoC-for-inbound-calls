/**
 * Analytics and metrics tracking for voice assistant calls
 */

export type CallMetrics = {
  callId: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  toolCalls: ToolCallMetric[];
  transcripts: TranscriptEntry[];
  responseCount: number;
  userSpeechEvents: number;
  bargeInEvents: number;
  status: "active" | "completed" | "failed" | "transferred";
  transferReason?: string;
  sentiment?: "positive" | "neutral" | "negative";
  metadata: Record<string, unknown>;
};

export type ToolCallMetric = {
  name: string;
  timestamp: number;
  duration: number;
  success: boolean;
  args?: unknown;
  error?: string;
};

export type TranscriptEntry = {
  timestamp: number;
  speaker: "user" | "assistant";
  text: string;
  sentiment?: "positive" | "neutral" | "negative";
};

export type SystemStats = {
  totalCalls: number;
  activeCalls: number;
  completedCalls: number;
  failedCalls: number;
  transferredCalls: number;
  averageCallDuration: number;
  totalToolCalls: number;
  toolCallsByType: Record<string, number>;
  uptime: number;
  startTime: number;
};

class AnalyticsEngine {
  private callMetrics = new Map<string, CallMetrics>();
  private systemStats: SystemStats;
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
    this.systemStats = {
      totalCalls: 0,
      activeCalls: 0,
      completedCalls: 0,
      failedCalls: 0,
      transferredCalls: 0,
      averageCallDuration: 0,
      totalToolCalls: 0,
      toolCallsByType: {},
      uptime: 0,
      startTime: this.startTime,
    };
  }

  startCall(callId: string): void {
    const metrics: CallMetrics = {
      callId,
      startTime: Date.now(),
      toolCalls: [],
      transcripts: [],
      responseCount: 0,
      userSpeechEvents: 0,
      bargeInEvents: 0,
      status: "active",
      metadata: {},
    };

    this.callMetrics.set(callId, metrics);
    this.systemStats.totalCalls++;
    this.systemStats.activeCalls++;
  }

  endCall(
    callId: string,
    status: "completed" | "failed" | "transferred" = "completed"
  ): void {
    const metrics = this.callMetrics.get(callId);
    if (!metrics) {
      return;
    }

    metrics.endTime = Date.now();
    metrics.duration = metrics.endTime - metrics.startTime;
    metrics.status = status;

    this.systemStats.activeCalls = Math.max(0, this.systemStats.activeCalls - 1);

    if (status === "completed") {
      this.systemStats.completedCalls++;
    } else if (status === "failed") {
      this.systemStats.failedCalls++;
    } else if (status === "transferred") {
      this.systemStats.transferredCalls++;
    }

    this.updateAverageCallDuration();
  }

  recordToolCall(callId: string, metric: ToolCallMetric): void {
    const metrics = this.callMetrics.get(callId);
    if (!metrics) {
      return;
    }

    metrics.toolCalls.push(metric);
    this.systemStats.totalToolCalls++;

    if (!this.systemStats.toolCallsByType[metric.name]) {
      this.systemStats.toolCallsByType[metric.name] = 0;
    }
    this.systemStats.toolCallsByType[metric.name]++;
  }

  recordTranscript(callId: string, entry: TranscriptEntry): void {
    const metrics = this.callMetrics.get(callId);
    if (!metrics) {
      return;
    }

    metrics.transcripts.push(entry);

    // Simple sentiment analysis based on keywords
    if (entry.speaker === "user") {
      entry.sentiment = this.analyzeSentiment(entry.text);
      metrics.sentiment = entry.sentiment;
    }
  }

  recordResponse(callId: string): void {
    const metrics = this.callMetrics.get(callId);
    if (metrics) {
      metrics.responseCount++;
    }
  }

  recordSpeechEvent(callId: string): void {
    const metrics = this.callMetrics.get(callId);
    if (metrics) {
      metrics.userSpeechEvents++;
    }
  }

  recordBargeIn(callId: string): void {
    const metrics = this.callMetrics.get(callId);
    if (metrics) {
      metrics.bargeInEvents++;
    }
  }

  setCallMetadata(
    callId: string,
    key: string,
    value: unknown
  ): void {
    const metrics = this.callMetrics.get(callId);
    if (metrics) {
      metrics.metadata[key] = value;
    }
  }

  setTransferReason(callId: string, reason: string): void {
    const metrics = this.callMetrics.get(callId);
    if (metrics) {
      metrics.transferReason = reason;
    }
  }

  private analyzeSentiment(text: string): "positive" | "neutral" | "negative" {
    const lowerText = text.toLowerCase();

    const positiveWords = [
      "thank",
      "thanks",
      "great",
      "excellent",
      "perfect",
      "good",
      "appreciate",
      "wonderful",
      "amazing",
      "helpful",
      "yes",
    ];
    const negativeWords = [
      "frustrated",
      "angry",
      "upset",
      "terrible",
      "bad",
      "horrible",
      "worst",
      "disappointed",
      "complaint",
      "problem",
      "issue",
      "no",
      "not working",
    ];

    const positiveCount = positiveWords.filter((word) =>
      lowerText.includes(word)
    ).length;
    const negativeCount = negativeWords.filter((word) =>
      lowerText.includes(word)
    ).length;

    if (positiveCount > negativeCount) {
      return "positive";
    }
    if (negativeCount > positiveCount) {
      return "negative";
    }
    return "neutral";
  }

  private updateAverageCallDuration(): void {
    const completedCalls = Array.from(this.callMetrics.values()).filter(
      (m) => m.duration !== undefined
    );

    if (completedCalls.length === 0) {
      return;
    }

    const totalDuration = completedCalls.reduce(
      (sum, m) => sum + (m.duration ?? 0),
      0
    );
    this.systemStats.averageCallDuration = totalDuration / completedCalls.length;
  }

  getCallMetrics(callId: string): CallMetrics | undefined {
    return this.callMetrics.get(callId);
  }

  getActiveCalls(): CallMetrics[] {
    return Array.from(this.callMetrics.values()).filter(
      (m) => m.status === "active"
    );
  }

  getAllCalls(): CallMetrics[] {
    return Array.from(this.callMetrics.values());
  }

  getRecentCalls(limit = 10): CallMetrics[] {
    return Array.from(this.callMetrics.values())
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit);
  }

  getSystemStats(): SystemStats {
    return {
      ...this.systemStats,
      uptime: Date.now() - this.startTime,
    };
  }

  getCallTranscript(callId: string): TranscriptEntry[] {
    const metrics = this.callMetrics.get(callId);
    return metrics?.transcripts ?? [];
  }

  generateCallSummary(callId: string): string | undefined {
    const metrics = this.callMetrics.get(callId);
    if (!metrics) {
      return undefined;
    }

    const duration = metrics.duration
      ? `${Math.floor(metrics.duration / 1000)}s`
      : "ongoing";
    const toolCallSummary = metrics.toolCalls
      .map((t) => t.name)
      .join(", ");
    const transcriptCount = metrics.transcripts.length;

    return `Call ${callId.slice(0, 8)}: ${duration}, ${transcriptCount} messages, tools: [${toolCallSummary}], sentiment: ${metrics.sentiment ?? "unknown"}`;
  }

  // Clean up old completed calls (keep last 100)
  cleanupOldCalls(): void {
    const allCalls = Array.from(this.callMetrics.entries())
      .filter(([_, m]) => m.status !== "active")
      .sort(([_, a], [__, b]) => b.startTime - a.startTime);

    if (allCalls.length > 100) {
      const toDelete = allCalls.slice(100);
      for (const [callId] of toDelete) {
        this.callMetrics.delete(callId);
      }
    }
  }
}

export const analytics = new AnalyticsEngine();

// Cleanup old calls every hour
setInterval(
  () => {
    analytics.cleanupOldCalls();
  },
  60 * 60 * 1000
);
