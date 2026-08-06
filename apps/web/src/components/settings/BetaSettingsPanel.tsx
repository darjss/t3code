import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import {
  usePrimarySettings,
  useSidebarV2Enabled,
  useUpdateClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { primaryServerConfigAtom } from "../../state/server";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const AUTO_SETTLE_MIN_DAYS = 1;
const AUTO_SETTLE_MAX_DAYS = 90;
const AUTO_SETTLE_DEFAULT_DAYS = 3;

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  // Local draft; commits only when editing FINISHES (blur or Enter), never
  // per keystroke. The setting drives a live server-side sweep, so a
  // transient "1" while typing "14" would settle threads a day old before
  // the real value lands — and un-settling later does not bring them back.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commitDraft = () => {
    // Number(), not parseInt: "3.5" must be rejected, not truncated to 3.
    const parsed = Number(draft);
    if (
      Number.isInteger(parsed) &&
      parsed >= AUTO_SETTLE_MIN_DAYS &&
      parsed <= AUTO_SETTLE_MAX_DAYS
    ) {
      if (parsed !== value) onCommit(parsed);
      setDraft(String(parsed));
    } else {
      setDraft(String(value));
    }
  };

  return (
    <Input
      type="number"
      min={AUTO_SETTLE_MIN_DAYS}
      max={AUTO_SETTLE_MAX_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commitDraft}
      onKeyDown={(event) => {
        if (event.key === "Enter") commitDraft();
      }}
      aria-label="Days of inactivity before auto-settle"
    />
  );
}

export function BetaSettingsPanel() {
  const sidebarV2Enabled = useSidebarV2Enabled();
  // Auto-settle is a server setting: the server derives settled state and
  // every client sees the same shelf, so the knob lives in settings.json.
  const threadAutoSettleAfterDays = usePrimarySettings(
    (settings) => settings.threadAutoSettleAfterDays,
  );
  const updateClientSettings = useUpdateClientSettings();
  const updateServerSettings = useUpdatePrimarySettings();
  // Only servers running the auto-settle sweep understand the setting;
  // showing the knob against an older server would persist a silent no-op.
  const supportsAutoSettle =
    useAtomValue(primaryServerConfigAtom)?.environment.capabilities.threadAutoSettle === true;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Beta features">
        <SettingsRow
          {...searchableSetting("sidebar-v2")}
          description="One flat thread list in creation order. Active work renders as rich cards; settled threads collapse to compact rows. Settling requires an up-to-date server — on older servers threads simply stay active. Switch back any time."
          control={
            <Switch
              checked={sidebarV2Enabled}
              // Touching the switch pins the choice, so a nightly build that
              // defaults v2 on does not flip it back after the user opts out.
              onCheckedChange={(checked) =>
                updateClientSettings({
                  sidebarV2Enabled: Boolean(checked),
                  sidebarV2ConfiguredByUser: true,
                })
              }
              aria-label="Enable the sidebar v2 beta"
            />
          }
        />
        {sidebarV2Enabled && supportsAutoSettle ? (
          <>
            <SettingsRow
              title={searchableSetting("auto-settle-inactive-threads").title}
              description="Threads with no activity for this long settle automatically. Threads on merged or closed PRs always settle. Applies on the server, so every device sees the same list."
              control={
                <Switch
                  checked={threadAutoSettleAfterDays !== null}
                  onCheckedChange={(checked) =>
                    updateServerSettings({
                      threadAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                    })
                  }
                  aria-label="Auto-settle inactive threads"
                />
              }
            />
            {threadAutoSettleAfterDays !== null ? (
              <SettingsRow
                title="Days of inactivity before auto-settle"
                description="Any new activity un-settles a thread automatically."
                control={
                  <AutoSettleDaysInput
                    value={threadAutoSettleAfterDays}
                    onCommit={(days) => updateServerSettings({ threadAutoSettleAfterDays: days })}
                  />
                }
              />
            ) : null}
          </>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
