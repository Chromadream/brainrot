import lume from "lume/mod.ts";
import attributes from "lume/plugins/attributes.ts";
import base_path from "lume/plugins/base_path.ts";
import date from "lume/plugins/date.ts";

const site = lume();

site.use(attributes());
site.use(base_path());
site.use(date());

export default site;
