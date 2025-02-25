import { Detail, ActionPanel, Action, Icon } from "@raycast/api";
import { withAccessToken } from "@raycast/utils";
import { authorize } from "./lib/oauth";
import { getPreferenceValues } from "@raycast/api";
import { useEffect, useState } from "react";
import fetch from "node-fetch";

interface Preferences {
    accessToken?: string;
}

interface ThreadsProfile {
    id: string;
    username: string;
    name: string;
    threads_profile_picture_url: string;
    threads_biography: string;
}

const preferences = getPreferenceValues<Preferences>();

function Profile({ accessToken }: { accessToken: string }) {
    const [profile, setProfile] = useState<ThreadsProfile | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        async function fetchProfile() {
            try {
                const response = await fetch(
                    `https://graph.threads.net/v1.0/me?fields=id,username,name,threads_profile_picture_url,threads_biography&access_token=${accessToken}`
                );

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const data = await response.json();
                setProfile(data);
            } catch (e) {
                setError(e instanceof Error ? e.message : "An error occurred while fetching profile");
            } finally {
                setIsLoading(false);
            }
        }

        fetchProfile();
    }, [accessToken]);

    if (error) {
        return <Detail markdown={`# Error\n\n${error}`} />;
    }

    if (isLoading) {
        return <Detail markdown="# Loading..." isLoading={true} />;
    }

    if (!profile) {
        return <Detail markdown="# No Profile Data\n\nUnable to load profile information." />;
    }

    const markdown = `
# ${profile.name} (@${profile.username})

![Profile Picture](${profile.threads_profile_picture_url})

## Bio
${profile.threads_biography || "*No bio provided*"}

## Profile Info
- **ID**: ${profile.id}
- **Username**: @${profile.username}
    `;

    return (
        <Detail
            markdown={markdown}
            actions={
                <ActionPanel>
                    <Action.OpenInBrowser
                        title="Open Profile in Threads"
                        url={`https://threads.net/@${profile.username}`}
                        icon={Icon.Globe}
                    />
                    <Action.CopyToClipboard
                        title="Copy Username"
                        content={profile.username}
                        shortcut={{ modifiers: ["cmd"], key: "c" }}
                    />
                </ActionPanel>
            }
        />
    );
}

export default withAccessToken({
    authorize,
    personalAccessToken: preferences.accessToken,
})(Profile);
