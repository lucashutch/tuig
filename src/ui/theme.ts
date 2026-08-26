export interface Theme {
  bg: string;
  panel: string;
  panelRaised: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
  selected: string;
  added: string;
  deleted: string;
  warning: string;
  author: string;
  divider: string;
  dividerActive: string;
  folder: string;
  folderBg: string;
  diffAddedBg: string;
  diffRemovedBg: string;
  graph: readonly string[];
}

export const oneDarkTheme: Theme = {
  bg: "#282C34",
  panel: "#21252B",
  panelRaised: "#2C313A",
  border: "#5C6370",
  text: "#ABB2BF",
  muted: "#5C6370",
  accent: "#61AFEF",
  accentSoft: "#56B6C2",
  selected: "#3E4451",
  added: "#98C379",
  deleted: "#E06C75",
  warning: "#E5C07B",
  author: "#C678DD",
  divider: "#2B5B61",
  dividerActive: "#315878",
  folder: "#61AFEF",
  folderBg: "#2C313A",
  diffAddedBg: "#30402F",
  diffRemovedBg: "#462C31",
  graph: ["#61AFEF", "#C678DD", "#E5C07B", "#98C379", "#E06C75", "#56B6C2"],
};
