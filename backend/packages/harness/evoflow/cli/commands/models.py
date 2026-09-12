"""evoflow models subcommands."""

from __future__ import annotations

import argparse

from evoflow.admin import models as models_admin
from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    models_parser = subparsers.add_parser("models", help="Manage AI model configuration")
    models_sub = models_parser.add_subparsers(dest="models_cmd", required=True)

    list_parser = models_sub.add_parser("list", help="List configured models")
    add_output_flags(list_parser)
    list_parser.set_defaults(handler=_list)

    get_parser = models_sub.add_parser("get", help="Get one model by name")
    get_parser.add_argument("name")
    add_output_flags(get_parser)
    get_parser.set_defaults(handler=_get)

    primary_parser = models_sub.add_parser("primary", help="Get or set primary model")
    primary_sub = primary_parser.add_subparsers(dest="primary_cmd", required=True)
    primary_get = primary_sub.add_parser("get", help="Show primary model")
    add_output_flags(primary_get)
    primary_get.set_defaults(handler=_primary_get)
    primary_set = primary_sub.add_parser("set", help="Set primary model")
    primary_set.add_argument("name")
    add_output_flags(primary_set)
    primary_set.set_defaults(handler=_primary_set)

    create_parser = models_sub.add_parser(
        "create",
        help="Create a model from JSON",
        description="JSON payload fields:\n"
        "  name (required)                Unique model identifier\n"
        "  model (required)               Model ID on the provider\n"
        "  base_url (required)            Provider base URL\n"
        "  api_key                        API key\n"
        "  vendor                         Vendor name (e.g. openai, anthropic)\n"
        "  display_name                   Human-readable name\n"
        "  description                    Model description\n"
        "  use                            Usage type (e.g. chat)\n"
        "  supports_thinking              Enable thinking (bool)\n"
        "  supports_reasoning_effort      Enable reasoning effort (bool)\n"
        "  supports_vision                Vision capable (bool)\n"
        "  max_tokens                     Max output tokens\n"
        "  context_length                 Context window size\n"
        "  when_thinking_enabled          Thinking config expression\n"
        "  thinking                       Thinking parameters\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_json_input_flags(create_parser)
    add_output_flags(create_parser)
    create_parser.set_defaults(handler=_create)

    update_parser = models_sub.add_parser(
        "update",
        help="Update a model from JSON",
        description="JSON payload fields (all optional, partial update):\n"
        "  model, base_url, api_key, vendor, display_name, description,\n"
        "  use, supports_thinking, supports_reasoning_effort,\n"
        "  supports_vision, max_tokens, context_length,\n"
        "  when_thinking_enabled, thinking\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    update_parser.add_argument("name")
    add_json_input_flags(update_parser)
    add_output_flags(update_parser)
    update_parser.set_defaults(handler=_update)

    delete_parser = models_sub.add_parser("delete", help="Delete a model")
    delete_parser.add_argument("name")
    add_output_flags(delete_parser)
    delete_parser.set_defaults(handler=_delete)

    test_parser = models_sub.add_parser(
        "test",
        help="Test remote model connection",
        description="JSON payload fields:\n"
        "  base_url (required)            Provider base URL\n"
        "  model_id (required)            Model ID to test\n"
        "  api_key                        API key\n"
        "  api_type                       'openai-completions' (default), 'anthropic-messages', or 'google-generative-ai'\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_json_input_flags(test_parser)
    add_output_flags(test_parser)
    test_parser.set_defaults(handler=_test)

    invoke_parser = models_sub.add_parser(
        "invoke",
        help="Invoke configured model",
        description="JSON payload fields:\n"
        "  model_name                     Model to invoke (optional, uses primary if omitted)\n"
        "  messages                       List of {role, content} objects\n"
        "  message / prompt               Shortcut: single user message\n"
        "  system                         System prompt\n"
        "  temperature                    Sampling temperature\n"
        "  max_tokens                     Max output tokens\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_json_input_flags(invoke_parser)
    add_output_flags(invoke_parser)
    invoke_parser.set_defaults(handler=_invoke)

    remote_parser = models_sub.add_parser(
        "list-remote",
        help="List models from remote OpenAI-compatible API",
        description="JSON payload fields:\n"
        "  base_url (required)            Provider base URL\n"
        "  api_key                        API key\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_json_input_flags(remote_parser)
    add_output_flags(remote_parser)
    remote_parser.set_defaults(handler=_list_remote)


def _list(args: argparse.Namespace):
    return models_admin.list_models()


def _get(args: argparse.Namespace):
    return models_admin.get_model(args.name)


def _primary_get(args: argparse.Namespace):
    return models_admin.get_primary_model()


def _primary_set(args: argparse.Namespace):
    return models_admin.set_primary_model(args.name)


def _create(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return models_admin.create_model(payload)


def _update(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return models_admin.update_model(args.name, payload)


def _delete(args: argparse.Namespace):
    return models_admin.delete_model(args.name)


def _test(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return models_admin.test_model_connection(payload)


def _invoke(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return models_admin.invoke_model(payload)


def _list_remote(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return models_admin.list_remote_models(payload)
