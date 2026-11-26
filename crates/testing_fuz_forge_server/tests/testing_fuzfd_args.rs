//! `testing_fuzfd`'s command line, against the real binary: the strict server
//! command line (`fuz_testing::assert_strict_server_argv`), with no arguments
//! serving as the cross-process harness spawns it.

#[test]
fn keeps_the_strict_server_command_line() {
    fuz_testing::assert_strict_server_argv(env!("CARGO_BIN_EXE_testing_fuzfd"), "testing_fuzfd");
}
