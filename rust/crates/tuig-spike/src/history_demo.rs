//! `--history`: the tuig-widgets history list on a real repository, full screen, for side-by-side comparison with
//! the TypeScript app.

use opentui::prelude::*;
use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use tuig_git::repository::{GitRepository, GitRepositoryService};
use tuig_ui_model::theme::one_dark_theme;
use tuig_widgets::history::{HistoryData, HistoryList};

const PAGE: usize = 250;

pub fn build(app: &App, repo: GitRepositoryService, rows: usize) -> Custom<HistoryList> {
    let repo = Arc::new(repo);
    let mut list = HistoryList::new(one_dark_theme());
    list.set_focused(true);
    let history = Custom::new(app, list).grow(1.0);
    let pane = View::new(app)
        .border(BorderStyle::Single)
        .title(" History ")
        .grow(1.0)
        .child(&history);
    app.root().add(&pane);
    history.focus();

    let paging = Rc::new(Cell::new(false));
    {
        let history = history.clone();
        app.on_key(move |cx, key| {
            let step = if key.matches("j") || key.matches("down") {
                1
            } else if key.matches("k") || key.matches("up") {
                -1
            } else {
                if key.matches("q") {
                    cx.quit();
                }
                return;
            };
            history.update(|list| {
                let row = list.viewport().selected as i64 + step;
                list.select(row.max(0) as usize);
            });
        });
    }
    {
        let (history, repo2, paging) = (history.clone(), repo.clone(), paging.clone());
        app.spawn(
            async move { repo2.snapshot(PAGE).await },
            move |cx, result| match result {
                Ok(snapshot) => {
                    history.update(|list| {
                        list.set_data(HistoryData {
                            commits: snapshot.commits,
                            branches: snapshot.branches,
                            working_files: snapshot.files.len(),
                            commits_complete: snapshot.commits_complete,
                        });
                        list.select(usize::from(list.data().working_files > 0));
                    });
                    load_more(cx.app(), &repo, &history, &paging, rows);
                }
                Err(error) => panic!("snapshot failed: {error}"),
            },
        );
    }
    history
}

/// Loads pages until the list holds `rows` commits or history ends.
fn load_more(
    app: &App,
    repo: &Arc<GitRepositoryService>,
    history: &Custom<HistoryList>,
    paging: &Rc<Cell<bool>>,
    rows: usize,
) {
    let (loaded, complete) =
        history.with(|list| (list.data().commits.len(), list.data().commits_complete));
    if complete || loaded >= rows || paging.replace(true) {
        return;
    }
    let (repo2, history2, paging2, repo3) =
        (repo.clone(), history.clone(), paging.clone(), repo.clone());
    app.spawn(
        async move { repo2.commit_page(PAGE, loaded).await },
        move |cx, result| {
            paging2.set(false);
            if let Ok(page) = result {
                history2.update(|list| list.append_commits(page.commits, page.complete));
                load_more(cx.app(), &repo3, &history2, &paging2, rows);
            }
        },
    );
}
