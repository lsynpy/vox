#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "httpx",
# ]
# ///
"""Add all songs to 'fav' playlist and remove invalid entries.

Uses Vox API: GET /api/flatten for all songs, PUT /api/fav to update.
Invalid songs are auto-filtered by the backend when saving.
"""
import asyncio
import os
from urllib.parse import urljoin

import httpx


async def login(client: httpx.AsyncClient, base_url: str) -> str | None:
    username = os.environ.get("POLARIS_USER", "admin")
    password = os.environ.get("POLARIS_PASSWORD", "admin")

    resp = await client.post(
        urljoin(base_url, "/api/auth"),
        json={"username": username, "password": password},
    )
    if resp.status_code == 200:
        return resp.json().get("token")
    print(f"Auth failed: {resp.status_code}")
    return None


async def main():
    base_url = "http://192.168.100.1:5050"
    playlist_name = "fav"

    async with httpx.AsyncClient(timeout=60) as client:
        token = await login(client, base_url)
        if not token:
            print("Failed to authenticate")
            return
        headers = {"Authorization": f"Bearer {token}", "Accept-Version": "8"}

        print("Getting all songs...")
        resp = await client.get(urljoin(base_url, "/api/flatten"), headers=headers)
        if resp.status_code != 200:
            print(f"Failed to get songs: {resp.status_code}")
            return
        all_paths = resp.json().get("paths", [])
        print(f"Found {len(all_paths)} songs")

        print(f"Adding all songs to playlist '{playlist_name}'...")
        resp = await client.put(
            urljoin(base_url, f"/api/playlist/{playlist_name}"),
            headers=headers,
            json={"tracks": all_paths},
        )
        if resp.status_code not in (200, 204):
            print(f"Failed to update playlist: {resp.status_code} - {resp.text}")
            return
        print(f"Successfully added {len(all_paths)} songs to '{playlist_name}'")

        print(f"Verifying and cleaning invalid songs in '{playlist_name}'...")
        resp = await client.get(
            urljoin(base_url, f"/api/playlist/{playlist_name}"), headers=headers
        )
        if resp.status_code != 200:
            print(f"Failed to get playlist: {resp.status_code}")
            return

        playlist_data = resp.json()
        valid_paths = playlist_data.get("songs", {}).get("paths", [])
        print(f"Playlist now has {len(valid_paths)} valid songs (invalid ones auto-filtered)")

        if len(valid_paths) != len(all_paths):
            print(f"Removed {len(all_paths) - len(valid_paths)} invalid songs")
            resp = await client.put(
                urljoin(base_url, f"/api/playlist/{playlist_name}"),
                headers=headers,
                json={"tracks": valid_paths},
            )
            if resp.status_code in (200, 204):
                print("Cleaned playlist saved successfully")

        print("Done!")


if __name__ == "__main__":
    asyncio.run(main())
