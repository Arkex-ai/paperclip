import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  agents, agentSessionGoalActions, companies, createDb, heartbeatRuns,
  issues, startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { runnerGoalService } from "../services/runner-goals.js";

describe("isolated native session-goal recovery", () => {
  it("redelivers the original action after a committed action loses dispatch", async () => {
    const pg = await startEmbeddedPostgresTestDatabase("arkex-r4-native-");
    try {
      const db = createDb(pg.connectionString);
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const responsibleUserId = randomUUID();
      const requestId = randomUUID();
      await db.insert(companies).values({
        id: companyId, name: "Isolated R4 proof", issuePrefix: "R4ISO",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId, companyId, name: "Isolated runner", role: "engineer",
        status: "idle", adapterType: "paperclip_runner", adapterConfig: {},
        runtimeConfig: {}, permissions: {},
      });
      await db.insert(issues).values({
        id: issueId, companyId, identifier: `R4ISO-${Math.floor(Math.random() * 1_000_000)}`,
        title: "Continue productive goal", status: "in_progress", assigneeAgentId: agentId,
        responsibleUserId,
      });

      const action = await runnerGoalService(db, {
        // Simulate process loss after the action commit and before offline dispatch.
        enqueueOfflineControl: async () => {},
      }).act(companyId, issueId, {
        requestId, agentId, expectedRevision: 0, action: "create",
        objective: "Complete the same work after interruption",
      });
      expect(action.projection.pendingAction).toBe("starting");
      expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
      expect(await db.select().from(agentSessionGoalActions)).toHaveLength(1);

      const restarted = heartbeatService(db);
      const first = await restarted.recoverPendingSessionGoalActions();
      expect(first).toMatchObject({ scanned: 1, enqueued: 1 });
      const runs = await db.select().from(heartbeatRuns);
      expect(runs).toHaveLength(1);
      expect(runs[0].contextSnapshot).toMatchObject({
        goalControlRequestId: requestId,
        runnerGoalControl: { requestId },
      });
      const second = await restarted.recoverPendingSessionGoalActions();
      expect(second).toMatchObject({ scanned: 1, enqueued: 0, alreadyQueued: 1 });
      expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
      await restarted.waitForRunExecutionDrain(runs[0].id, { timeoutMs: 20_000 });
    } finally {
      await pg.cleanup();
    }
  }, 60_000);
});
