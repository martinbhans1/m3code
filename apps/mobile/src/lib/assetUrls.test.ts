import { describe, expect, it } from "vite-plus/test";

import { localImagePathFromHref } from "./assetUrls";

describe("localImagePathFromHref", () => {
  it("reads the Windows path shapes agents write", () => {
    expect(localImagePathFromHref("/C:/Users/Martin/shot.png")).toBe("C:/Users/Martin/shot.png");
    expect(localImagePathFromHref("C:/Users/Martin/shot.png")).toBe("C:/Users/Martin/shot.png");
    expect(localImagePathFromHref("C:\\Users\\Martin\\shot.png")).toBe(
      "C:\\Users\\Martin\\shot.png",
    );
    expect(localImagePathFromHref("</C:/Users/Martin/shot.png>")).toBe("C:/Users/Martin/shot.png");
    expect(localImagePathFromHref("file:///C:/Users/Martin/my%20shot.png")).toBe(
      "C:/Users/Martin/my shot.png",
    );
  });

  it("reads POSIX absolute paths", () => {
    expect(localImagePathFromHref("/Users/martin/shot.png")).toBe("/Users/martin/shot.png");
    expect(localImagePathFromHref("file:///tmp/shot.png")).toBe("/tmp/shot.png");
  });

  it("leaves loadable and relative hrefs alone", () => {
    expect(localImagePathFromHref("https://example.com/shot.png")).toBeNull();
    expect(localImagePathFromHref("data:image/png;base64,AAAA")).toBeNull();
    expect(localImagePathFromHref("//cdn.example.com/shot.png")).toBeNull();
    expect(localImagePathFromHref("screenshot-after-reload")).toBeNull();
  });
});
