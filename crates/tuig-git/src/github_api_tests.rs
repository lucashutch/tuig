use super::*;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct FakeHttp {
    replies: Mutex<VecDeque<Result<HttpReply, String>>>,
    /// The token of each request, in order.
    seen: Mutex<Vec<String>>,
}

impl FakeHttp {
    fn replying(replies: Vec<Result<HttpReply, String>>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            ..Self::default()
        })
    }

    fn answer(&self, token: &str) -> Result<HttpReply, String> {
        self.seen.lock().unwrap().push(token.to_string());
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("a queued reply")
    }
}

impl Http for Arc<FakeHttp> {
    fn post_json(&self, _url: &str, token: &str, _body: &str) -> Result<HttpReply, String> {
        self.answer(token)
    }
    fn get(&self, _url: &str, token: &str) -> Result<HttpReply, String> {
        self.answer(token)
    }
}

/// Hands out the queued tokens, then none. Counts the reads.
struct FakeTokens {
    queue: Mutex<VecDeque<Option<String>>>,
    reads: Arc<AtomicUsize>,
}

impl TokenSource for FakeTokens {
    fn token(&self, _host: &str) -> Option<String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.queue.lock().unwrap().pop_front().flatten()
    }
}

fn api(
    replies: Vec<Result<HttpReply, String>>,
    tokens: &[Option<&str>],
) -> (GithubApi, Arc<FakeHttp>, Arc<AtomicUsize>) {
    let http = FakeHttp::replying(replies);
    let reads = Arc::new(AtomicUsize::new(0));
    let source = FakeTokens {
        queue: Mutex::new(tokens.iter().map(|t| t.map(str::to_string)).collect()),
        reads: reads.clone(),
    };
    (
        GithubApi::new(Box::new(http.clone()), Box::new(source)),
        http,
        reads,
    )
}

fn reply(status: u16, body: &str) -> Result<HttpReply, String> {
    Ok(HttpReply {
        status,
        body: body.to_string(),
    })
}

#[test]
fn the_token_is_read_once_per_host_and_reused() {
    let (api, http, reads) = api(vec![reply(200, "a"), reply(200, "b")], &[Some("t1")]);
    assert!(matches!(api.get("github.com", "u"), ApiReply::Response(r) if r.body == "a"));
    assert!(matches!(api.get("github.com", "u"), ApiReply::Response(r) if r.body == "b"));
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert_eq!(*http.seen.lock().unwrap(), ["t1", "t1"]);
}

#[test]
fn a_401_rereads_the_token_once_and_retries() {
    let (api, http, reads) = api(
        vec![reply(401, ""), reply(200, "ok")],
        &[Some("old"), Some("new")],
    );
    assert!(
        matches!(api.post_json("github.com", "u", "{}"), ApiReply::Response(r) if r.body == "ok")
    );
    assert_eq!(*http.seen.lock().unwrap(), ["old", "new"]);
    assert_eq!(reads.load(Ordering::SeqCst), 2);
}

#[test]
fn a_second_401_is_unauthorized_and_does_not_retry_again() {
    let (api, http, reads) = api(
        vec![reply(401, ""), reply(401, "")],
        &[Some("old"), Some("new")],
    );
    assert_eq!(
        api.post_json("github.com", "u", "{}"),
        ApiReply::Unauthorized
    );
    assert_eq!(http.seen.lock().unwrap().len(), 2);
    assert_eq!(reads.load(Ordering::SeqCst), 2);
}

#[test]
fn a_missing_token_makes_no_request_and_is_remembered() {
    let (api, http, reads) = api(vec![], &[None]);
    assert_eq!(api.get("github.com", "u"), ApiReply::NoToken);
    assert_eq!(api.get("github.com", "u"), ApiReply::NoToken);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(http.seen.lock().unwrap().is_empty());
}

#[test]
fn remotes_resolve_to_host_owner_and_repository() {
    let repo = |host: &str, owner: &str, name: &str| RepoRef {
        host: host.into(),
        owner: owner.into(),
        name: name.into(),
    };
    for (remote, expected) in [
        ("git@github.com:o/r.git", Some(repo("github.com", "o", "r"))),
        ("https://github.com/o/r", Some(repo("github.com", "o", "r"))),
        (
            "https://tok@GitHub.com/o/r.git/",
            Some(repo("github.com", "o", "r")),
        ),
        (
            "ssh://git@ghe.example.com/o/r.git",
            Some(repo("ghe.example.com", "o", "r")),
        ),
        ("ssh://git@ghe.example.com:2222/o/r.git", None),
        ("https://github.com/o/r/extra", None),
        ("/srv/git/r.git", None),
    ] {
        assert_eq!(parse_remote(remote), expected, "{remote}");
    }
}

#[test]
fn the_remote_choice_follows_gh() {
    let config = "remote.origin.url git@github.com:me/fork.git\n\
                  remote.upstream.url git@github.com:org/proj.git\n";
    assert_eq!(
        choose_repo(config).unwrap().owner,
        "org",
        "upstream beats origin"
    );
    let config = "remote.origin.url git@github.com:me/fork.git\n\
                  remote.other.url git@github.com:x/y.git\n\
                  remote.other.gh-resolved base\n";
    assert_eq!(
        choose_repo(config).unwrap().owner,
        "x",
        "a default repo wins"
    );
    let config = "remote.origin.url git@github.com:me/fork.git\n\
                  remote.origin.gh-resolved org/proj\n";
    let repo = choose_repo(config).unwrap();
    assert_eq!((repo.owner.as_str(), repo.name.as_str()), ("org", "proj"));
    assert_eq!(choose_repo(""), None);
}

#[test]
fn endpoints_follow_the_host() {
    assert_eq!(graphql_url("github.com"), "https://api.github.com/graphql");
    assert_eq!(
        graphql_url("ghe.example.com"),
        "https://ghe.example.com/api/graphql"
    );
    assert_eq!(
        rest_url("ghe.example.com"),
        "https://ghe.example.com/api/v3"
    );
}
