interface RegExpConstructor {
  /**
   * Returns a string value that can be used to replace the regular expression
   * in a string so that it will be interpreted literally.
   * @param s The string to be escaped.
   */
  escape(s: string): string;
}
